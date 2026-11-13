import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createPgliteDb, setDbFactory } from "@/lib/server/db";
import { createLocalUser } from "@/lib/server/auth";
import * as admin from "@/lib/server/admin";
import { getContestView, joinContest } from "@/lib/server/contests";
import { getWallet } from "@/lib/server/wallet";
import { getProfile } from "@/lib/server/profiles";
import { addFriendsToContest, friendStatus, listFriends, removeFriend, respondFriendRequest, sendFriendRequest } from "@/lib/server/friends";
import { createManualContest, editContestDetails, getManageView, setManualScores } from "@/lib/server/manual";
import { claimAchievement, listAchievements } from "@/lib/server/achievements";

const ids: Record<string, string> = {};
const PW = "password123";
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string; message?: string }).code ?? (e as Error).message;
  }
};
const bal = async (u: string) => (await getWallet(ids[u])).balance;

beforeAll(async () => {
  setDbFactory(() => createPgliteDb("memory://"));
  for (const u of ["ann", "ben", "cat", "dan"]) ids[u] = await createLocalUser(u, PW, u);
});

describe("friends", () => {
  it("request → accept → listed on both sides", async () => {
    expect((await sendFriendRequest(ids.ann, "ben")).result).toBe("requested");
    expect(await friendStatus(ids.ann, ids.ben)).toBe("outgoing");
    expect(await friendStatus(ids.ben, ids.ann)).toBe("incoming");
    expect((await listFriends(ids.ben)).incoming.map((f) => f.username)).toEqual(["ann"]);
    await respondFriendRequest(ids.ben, ids.ann, true);
    expect(await friendStatus(ids.ann, ids.ben)).toBe("friends");
    expect((await listFriends(ids.ann)).friends.map((f) => f.username)).toEqual(["ben"]);
    expect((await sendFriendRequest(ids.ben, "ann")).result).toBe("already");
  });

  it("asking someone who already asked you makes you friends", async () => {
    await sendFriendRequest(ids.cat, "ann");
    expect((await sendFriendRequest(ids.ann, "cat")).result).toBe("accepted");
    expect(await friendStatus(ids.cat, ids.ann)).toBe("friends");
  });

  it("decline, remove, self and unknown users", async () => {
    await sendFriendRequest(ids.dan, "ben");
    await respondFriendRequest(ids.ben, ids.dan, false);
    expect(await friendStatus(ids.ben, ids.dan)).toBe("none");
    expect(await code(sendFriendRequest(ids.dan, "dan"))).toBe("cant_friend_self");
    expect(await code(sendFriendRequest(ids.dan, "nobody_here"))).toBe("user_not_found");
    await sendFriendRequest(ids.dan, "cat");
    await respondFriendRequest(ids.cat, ids.dan, true);
    await removeFriend(ids.dan, ids.cat);
    expect(await friendStatus(ids.cat, ids.dan)).toBe("none");
  });

  it("players can't read other people's friendships or write the table directly", async () => {
    const rows = await asUser(ids.dan, (q) => q.query("select * from public.friendships"));
    expect(rows.length).toBe(0);
    expect(await code(asUser(ids.dan, (q) => q.query("insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')", [ids.dan, ids.ann])))).toBe("forbidden");
  });
});

describe("player-run bet (pick a side)", () => {
  let cid = "";
  it("any player can create one; it starts private and in setup", async () => {
    cid = await createManualContest(ids.ann, { kind: "bet", title: "Who wins Sunday?", stake: 20, sides: ["Chiefs", "Bills"] });
    const v = await getContestView(ids.ann, cid);
    expect(v.contest.manual).toBe(true);
    expect(v.contest.status).toBe("setup");
    expect(v.contest.visibility).toBe("private");
    expect(v.viewer.can_manage).toBe(true);
    expect(v.outcomes.map((o) => o.label)).toEqual(["Chiefs", "Bills"]);
    // others can't see it yet
    expect(await code(getContestView(ids.dan, cid))).toBe("contest_not_found");
  });

  it("organizer adds friends; only friends can be added", async () => {
    expect(await code(addFriendsToContest(ids.ann, cid, [ids.dan]))).toBe("not_friends");
    expect((await addFriendsToContest(ids.ann, cid, [ids.ben, ids.cat])).added).toBe(2);
    const m = await getManageView(ids.ann, cid);
    expect(m.friends.filter((f) => f.invited).map((f) => f.username).sort()).toEqual(["ben", "cat"]);
  });

  it("non-organizers can't manage it, even through actions", async () => {
    expect(await code(admin.setStatus(ids.ben, cid, "open"))).toBe("forbidden");
    expect(await code(getManageView(ids.ben, cid))).toBe("forbidden");
    const hijack = await asUser(ids.ben, (q) => q.query("update public.contests set title = 'hijacked' where id = $1 returning id", [cid]));
    expect(hijack).toHaveLength(0); // RLS: the row isn't updatable by non-organizers
    expect(await code(asUser(ids.ben, (q) => q.query("insert into public.contest_outcomes (contest_id, label) values ($1, 'Draw')", [cid])))).toBe("forbidden");
  });

  it("open → join → lock → pick winner → pay out", async () => {
    await admin.setStatus(ids.ann, cid, "open");
    const v0 = await getContestView(ids.ann, cid);
    const [chiefs, bills] = v0.outcomes;
    const before = { ann: await bal("ann"), ben: await bal("ben"), cat: await bal("cat") };
    await joinContest(ids.ann, cid, chiefs.id);
    await joinContest(ids.ben, cid, bills.id);
    await joinContest(ids.cat, cid, chiefs.id);
    await admin.setStatus(ids.ann, cid, "locked");
    await admin.setStatus(ids.ann, cid, "awaiting_settlement");
    const pv = await admin.settlementPreview(ids.ann, cid, chiefs.id);
    expect(pv.pot).toBe(60);
    await admin.settleContest(ids.ann, cid, chiefs.id, pv.hash);
    expect(await bal("ann")).toBe(before.ann + 10);
    expect(await bal("cat")).toBe(before.cat + 10);
    expect(await bal("ben")).toBe(before.ben - 20);
    expect((await getContestView(ids.ben, cid)).contest.status).toBe("settled");
  });

  it("organizer can edit the title and description any time, others can't", async () => {
    // entries are locked and it's even settled: details are still editable
    await editContestDetails(ids.ann, cid, { title: "Sunday night: Chiefs vs Bills", description: "Winner by final score.\nOT counts." });
    const v = await getContestView(ids.ben, cid);
    expect(v.contest.title).toBe("Sunday night: Chiefs vs Bills");
    expect(v.contest.description).toBe("Winner by final score.\nOT counts.");
    expect(await code(editContestDetails(ids.ben, cid, { title: "mine now", description: "" }))).toBe("forbidden");
    expect(await code(editContestDetails(ids.ann, cid, { title: "x", description: "" }))).not.toBe("ok");
  });

  it("players can't create admin-style contests or flip the manual flag", async () => {
    expect(await code(asUser(ids.dan, (q) =>
      q.query("insert into public.contests (kind, title, payout_rule, manual, created_by) values ('bet', 'sneaky', 'equal_split_winners', false, auth.uid())")))).toBe("forbidden");
    const mine = await createManualContest(ids.dan, { kind: "bet", title: "Coin flip", stake: 0, sides: ["Heads", "Tails"] });
    expect(await code(asUser(ids.dan, (q) => q.query("update public.contests set manual = false where id = $1", [mine])))).toBe("forbidden");
  });
});

describe("player-run draft with typed-in scores", () => {
  let cid = "";
  it("rosters, scores, every roster visible, payout to the top total", async () => {
    cid = await createManualContest(ids.ben, { kind: "draft", title: "Masters pool", stake: 30, roster_size: 2 });
    await addFriendsToContest(ids.ben, cid, [ids.ann]);
    await admin.setStatus(ids.ben, cid, "open");
    await joinContest(ids.ben, cid, null);
    await joinContest(ids.ann, cid, null);
    const v0 = await getContestView(ids.ben, cid);
    const e = Object.fromEntries(v0.entrants.map((x) => [x.username, x.entry_id]));
    await admin.importDraft(ids.ben, cid, [
      { entry_id: e.ben, picks: ["Scheffler", "McIlroy"] },
      { entry_id: e.ann, picks: ["Rahm", "Morikawa"] },
    ]);
    const v1 = await getContestView(ids.ann, cid);
    expect(v1.contest.status).toBe("active");
    expect(v1.rosters).toHaveLength(2);
    const item = (name: string) => v1.draft!.pool.find((p) => p.name === name)!.id;
    expect(await code(setManualScores(ids.ann, cid, [{ pool_item_id: item("Rahm"), points: 99 }]))).toBe("forbidden");
    const r = await setManualScores(ids.ben, cid, [
      { pool_item_id: item("Scheffler"), points: 12 },
      { pool_item_id: item("McIlroy"), points: 3 },
      { pool_item_id: item("Rahm"), points: 8 },
      { pool_item_id: item("Morikawa"), points: 9.5 },
    ]);
    expect(r.changed).toBe(4);
    const v2 = await getContestView(ids.ann, cid);
    const totals = Object.fromEntries(v2.rosters.map((x) => [x.username, x.total]));
    expect(totals).toEqual({ ann: 17.5, ben: 15 });
    expect(v2.rosters[0].picks.find((p) => p.name === "Morikawa")!.lines[0].label).toBe("Score");
    expect(v2.changes[0].summary).toMatch(/Updated 4 scores/);

    const annBefore = await bal("ann");
    await admin.setStatus(ids.ben, cid, "awaiting_settlement");
    const pv = await admin.settlementPreview(ids.ben, cid, null);
    expect(pv.lines.find((l) => l.username === "ann")!.payout).toBe(60);
    await admin.settleContest(ids.ben, cid, null, pv.hash);
    expect(await bal("ann")).toBe(annBefore + 60);
    expect(await code(setManualScores(ids.ben, cid, [{ pool_item_id: item("Rahm"), points: 1 }]))).toBe("contest_closed");
  });
});

describe("achievements", () => {
  it("unlocks from real activity, pays once, and shows on the list", async () => {
    const list = await listAchievements(ids.ann);
    const state = (id: string) => list.items.find((i) => i.id === id)!.state;
    expect(state("first_entry")).toBe("ready");
    expect(state("first_win")).toBe("ready");
    expect(state("squad_up")).toBe("ready");
    expect(state("commish")).toBe("ready");
    expect(state("closer")).toBe("ready");
    expect(state("hat_trick")).toBe("locked");
    const before = await bal("ann");
    const r = await claimAchievement(ids.ann, "first_win");
    expect(r).toMatchObject({ claimed: true, reward: 20, balance: before + 20 });
    const again = await claimAchievement(ids.ann, "first_win");
    expect(again.claimed).toBe(false);
    expect(await bal("ann")).toBe(before + 20);
    expect((await listAchievements(ids.ann)).items.find((i) => i.id === "first_win")!.state).toBe("claimed");
    const [l] = await asService((q) => q.query("select count(*)::int as n from public.ledger where user_id = $1 and kind = 'achievement'", [ids.ann]));
    expect(l.n).toBe(1);
  });

  it("locked achievements can't be claimed", async () => {
    expect(await code(claimAchievement(ids.dan, "hat_trick"))).toBe("achievement_locked");
    expect(await code(claimAchievement(ids.dan, "made_up"))).toBe("validation");
  });

  it("the claim function is server-only", async () => {
    expect(await code(asUser(ids.dan, (q) => q.query("select sidebet_private.claim_achievement($1, 'hat_trick', 500, 'x')", [ids.dan])))).toBe("forbidden");
  });

  it("profile shows fun stats", async () => {
    const p = await getProfile(ids.ann, "ann");
    expect(p.stats.wins).toBe(2);
    expect(p.stats.best_streak).toBe(2);
    expect(p.stats.biggest_win).toBe(30);
    expect(p.stats.chips_won).toBe(40);
    expect(p.stats.win_rate).toBe(100);
  });

  it("free chips are now 10", async () => {
    const [s] = await asService((q) => q.query("select claim_amount from public.app_settings where id = 1"));
    expect(s.claim_amount).toBe(10);
  });
});
