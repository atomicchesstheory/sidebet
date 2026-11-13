import { asUser, getDb } from "./db";
import { notifyContest } from "./live";

export type FriendRow = { user_id: string; username: string; since: string };

export async function listFriends(userId: string) {
  return asUser(userId, async (q) => {
    const rows = await q.query<{ requester: string; addressee: string; status: string; created_at: string; responded_at: string | null; username: string; other_id: string }>(
      `select f.requester, f.addressee, f.status, f.created_at, f.responded_at, p.username, p.id as other_id
         from public.friendships f
         join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
        order by p.username`,
    );
    const iso = (d: string | null) => (d ? new Date(d).toISOString() : "");
    return {
      friends: rows.filter((r) => r.status === "accepted").map((r) => ({ user_id: r.other_id, username: r.username, since: iso(r.responded_at ?? r.created_at) })),
      incoming: rows.filter((r) => r.status === "pending" && r.addressee === userId).map((r) => ({ user_id: r.other_id, username: r.username, since: iso(r.created_at) })),
      outgoing: rows.filter((r) => r.status === "pending" && r.requester === userId).map((r) => ({ user_id: r.other_id, username: r.username, since: iso(r.created_at) })),
    };
  });
}
export type FriendsView = Awaited<ReturnType<typeof listFriends>>;

/** 'friends' | 'incoming' | 'outgoing' | 'none' between the viewer and another player. */
export async function friendStatus(userId: string, otherId: string) {
  if (userId === otherId) return "self" as const;
  return asUser(userId, async (q) => {
    const [r] = await q.query<{ requester: string; status: string }>(
      "select requester, status from public.friendships where (requester = auth.uid() and addressee = $1) or (requester = $1 and addressee = auth.uid())",
      [otherId],
    );
    if (!r) return "none" as const;
    if (r.status === "accepted") return "friends" as const;
    return r.requester === userId ? ("outgoing" as const) : ("incoming" as const);
  });
}

export async function sendFriendRequest(userId: string, username: string) {
  return asUser(userId, async (q) => {
    const [r] = await q.query<{ r: string }>("select public.send_friend_request($1) as r", [username]);
    return { result: r.r as "requested" | "accepted" | "already" };
  });
}

export async function respondFriendRequest(userId: string, requesterId: string, accept: boolean) {
  await asUser(userId, (q) => q.query("select public.respond_friend_request($1, $2)", [requesterId, accept]));
}

export async function removeFriend(userId: string, otherId: string) {
  await asUser(userId, (q) => q.query("select public.remove_friend($1)", [otherId]));
}

export async function addFriendsToContest(userId: string, contestId: string, userIds: string[]) {
  const n = await asUser(userId, async (q) => {
    const [r] = await q.query<{ n: number }>("select public.add_friends_to_contest($1, $2::uuid[]) as n", [contestId, userIds]);
    return r.n;
  });
  notifyContest(contestId);
  return { added: n };
}

/** Pending requests waiting on this player (nav badge). One query, no transaction. */
export async function incomingRequestCount(userId: string) {
  const db = await getDb();
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from public.friendships where addressee = $1 and status = 'pending'", [userId]);
  return Number(r?.n ?? 0);
}
