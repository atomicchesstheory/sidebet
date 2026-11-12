import { asUser, num } from "./db";
import { AppError } from "./errors";

type HistRow = {
  entry_id: string;
  contest_id: string;
  title: string;
  kind: "bet" | "draft";
  category: string;
  contest_status: string;
  status: string;
  place: number | null;
  payout: number;
  refund: number;
  stake: number;
  final_points: number | null;
  settled_at: string | null;
  entrants: number;
  pick_label: string | null;
  roster: string[] | null;
};

/** Profile + history, as seen by `viewerId` (RLS hides contests/picks the viewer can't see). */
export async function getProfile(viewerId: string, username: string) {
  return asUser(viewerId, async (q) => {
    const [p] = await q.query<{ id: string; username: string; display_name: string; is_admin: boolean; created_at: string }>(
      "select id, username, display_name, is_admin, created_at from public.profiles where username = $1",
      [username.toLowerCase()],
    );
    if (!p) throw new AppError("validation", "No such player.");

    const history = await q.query<HistRow>(
      `select e.id as entry_id, c.id as contest_id, c.title, c.kind, c.category, c.status as contest_status, e.status, e.place,
              e.payout, e.refund, e.stake, e.final_points, c.settled_at,
              (select count(*)::int from public.entries x where x.contest_id = c.id) as entrants,
              (select o.label from public.bet_picks b join public.contest_outcomes o on o.id = b.outcome_id where b.entry_id = e.id) as pick_label,
              (select array_agg(pi.name order by d.pick_no) from public.draft_picks d join public.pool_items pi on pi.id = d.pool_item_id
                where d.entry_id = e.id) as roster
         from public.entries e join public.contests c on c.id = e.contest_id
        where e.user_id = $1
        order by coalesce(c.settled_at, c.canceled_at, e.joined_at) desc`,
      [p.id],
    );

    const settled = history.filter((h) => h.contest_status === "settled");
    const stats = {
      completed: settled.length,
      bets_completed: settled.filter((h) => h.kind === "bet").length,
      drafts_completed: settled.filter((h) => h.kind === "draft").length,
      wins: settled.filter((h) => h.status === "won").length,
      losses: settled.filter((h) => h.status === "lost").length,
      ties: settled.filter((h) => h.status === "tied").length,
      pushes: settled.filter((h) => h.status === "push").length,
      canceled: history.filter((h) => h.contest_status === "canceled").length,
      in_play: history.filter((h) => !["settled", "canceled"].includes(h.contest_status)).length,
      // payouts + refunds − stakes across every contest entry (claims/grants excluded)
      net_chips: history.reduce((s, h) => s + num(h.payout) + num(h.refund) - num(h.stake), 0),
    };
    const draftFinishes = settled
      .filter((h) => h.kind === "draft")
      .map((h) => ({ contest_id: h.contest_id, title: h.title, place: h.place, of: h.entrants, points: h.final_points === null ? null : num(h.final_points) }));

    // Head-to-head: settled contests both players entered (canceled never count).
    const h2hRows = await q.query<{ other_id: string; username: string; display_name: string; my_place: number | null; their_place: number | null; my_status: string; their_status: string }>(
      `select o.user_id as other_id, pr.username, pr.display_name, me.place as my_place, o.place as their_place,
              me.status as my_status, o.status as their_status
         from public.entries me
         join public.entries o on o.contest_id = me.contest_id and o.user_id <> me.user_id
         join public.contests c on c.id = me.contest_id and c.status = 'settled'
         join public.profiles pr on pr.id = o.user_id
        where me.user_id = $1`,
      [p.id],
    );
    const h2h = new Map<string, { user_id: string; username: string; display_name: string; w: number; l: number; t: number }>();
    for (const r of h2hRows) {
      if (r.my_status === "push" || r.their_status === "push") continue;
      const rec = h2h.get(r.other_id) ?? { user_id: r.other_id, username: r.username, display_name: r.display_name, w: 0, l: 0, t: 0 };
      const a = r.my_place ?? 99;
      const b = r.their_place ?? 99;
      if (a < b) rec.w++;
      else if (a > b) rec.l++;
      else rec.t++;
      h2h.set(r.other_id, rec);
    }
    return { profile: p, stats, history, draftFinishes, h2h: [...h2h.values()].sort((x, y) => y.w + y.l + y.t - (x.w + x.l + x.t)) };
  });
}
export type ProfileView = Awaited<ReturnType<typeof getProfile>>;

export async function updateDisplayName(userId: string, name: string) {
  await asUser(userId, (q) => q.query("select public.update_display_name($1)", [name]));
}

// ---------------------------------------------------------- requests --
export async function submitRequest(userId: string, title: string, body: string) {
  return asUser(userId, async (q) => {
    const [r] = await q.query<{ id: string }>(
      "insert into public.contest_requests (user_id, title, body) values (auth.uid(), $1, $2) returning id",
      [title, body],
    );
    return r.id;
  });
}

export async function listRequests(userId: string) {
  return asUser(userId, (q) =>
    q.query<{ id: string; title: string; body: string; status: string; admin_note: string | null; contest_id: string | null; created_at: string; username: string }>(
      `select r.id, r.title, r.body, r.status, r.admin_note, r.contest_id, r.created_at, p.username
         from public.contest_requests r join public.profiles p on p.id = r.user_id order by r.created_at desc limit 100`,
    ),
  );
}
