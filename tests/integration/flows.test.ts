import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createPgliteDb, setDbFactory } from "@/lib/server/db";
import { createLocalUser } from "@/lib/server/auth";
import * as admin from "@/lib/server/admin";
import { getContestView, joinContest, makeDraftPick, redeemInvite } from "@/lib/server/contests";
import { claimChips, getWallet } from "@/lib/server/wallet";
import { getProfile } from "@/lib/server/profiles";
import { processFacts } from "@/lib/server/results/pipeline";
import { checkContest } from "@/lib/server/results/pipeline";
import { seedDemo, CHESS_RULES } from "@/lib/server/seed";
import type { EventFacts } from "@/lib/scoring/schema";

let seed: Awaited<ReturnType<typeof seedDemo>>;
const ids: Record<string, string> = {};
const PW = "password123";

async function shiftClock(seconds: number) {
  await asService((q) => q.query("update public.app_settings set clock_offset_seconds = clock_offset_seconds + $1 where id = 1", [seconds]));
}
async function balance(uid: string) {
  return (await getWallet(uid)).balance;
}
async function ledgerCount(uid: string, kind: string) {
  const [r] = await asService((q) => q.query("select count(*)::int as n from public.ledger where user_id = $1 and kind = $2", [uid, kind]));
  return r.n as number;
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string; message?: string }).code ?? (e as Error).message;
  }
};

beforeAll(async () => {
  setDbFactory(() => createPgliteDb("memory://"));
  seed = await seedDemo();
  Object.assign(ids, seed.ids);
  ids.dana = await createLocalUser("dana", PW, "Dana");
  ids.eli = await createLocalUser("eli", PW, "Eli");
  ids.zz = await createLocalUser("zz_outsider", PW, "Outsider");
});

describe("wallet and claims", () => {
  it("new accounts get 500 starting chips via the ledger", async () => {
    expect(await balance(ids.dana)).toBe(500);
    expect(await ledgerCount(ids.dana, "starting_grant")).toBe(1);
  });

  it("23-hour claim works exactly at the cutoff (server time)", async () => {
    const r = await claimChips(ids.dana);
    expect(r.amount).toBe(10);
    expect(await balance(ids.dana)).toBe(510);
    expect(await code(claimChips(ids.dana))).toBe("claim_not_ready");
    await shiftClock(23 * 3600 - 2);
    expect(await code(claimChips(ids.dana))).toBe("claim_not_ready");
    const w = await getWallet(ids.dana);
    expect(w.can_claim).toBe(false);
    expect(new Date(w.next_claim_at!).getTime() - new Date(w.server_now).getTime()).toBeLessThanOrEqual(2000);
    await shiftClock(2);
    expect(await code(claimChips(ids.dana))).toBe("ok");
    expect(await balance(ids.dana)).toBe(520);
  });

  it("concurrent claims grant exactly once", async () => {
    await shiftClock(23 * 3600);
    const before = await balance(ids.eli);
    const results = await Promise.all(Array.from({ length: 6 }, () => code(claimChips(ids.eli))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "claim_not_ready")).toHaveLength(5);
    expect(await balance(ids.eli)).toBe(before + 10);
    expect(await ledgerCount(ids.eli, "free_claim")).toBe(1);
  });
});

describe("private access, hidden picks, admin-only actions", () => {
  it("outsiders can't see or join private contests", async () => {
    expect(await code(getContestView(ids.zz, seed.chess))).toBe("contest_not_found");
    expect(await code(joinContest(ids.zz, seed.chess, null))).toBe("contest_not_found");
    const raw = await asUser(ids.zz, async (q) => ({
      contests: await q.query("select id from public.contests where id = $1", [seed.chess]),
      entries: await q.query("select id from public.entries where contest_id = $1", [seed.chess]),
      picks: await q.query("select id from public.draft_picks where contest_id = $1", [seed.chess]),
      signals: await q.query("select * from public.contest_signals where contest_id = $1", [seed.chess]),
      lines: await q.query("select * from public.score_lines where contest_id = $1", [seed.chess]),
    }));
    expect(Object.values(raw).every((r) => r.length === 0)).toBe(true);
  });

  it("anon role sees nothing at all", async () => {
    const rows = await asUser(null, (q) => q.query("select id from public.contests"));
    expect(rows).toHaveLength(0);
  });

  it("revoked invites stop working", async () => {
    const token = await admin.createInvite(ids.commish, seed.race, "temp");
    const [inv] = await asService((q) => q.query("select id from public.invites where token = $1", [token]));
    await admin.revokeInvite(ids.commish, inv.id);
    expect(await code(redeemInvite(ids.zz, token))).toBe("invite_revoked");
    expect(await code(getContestView(ids.zz, seed.race))).toBe("contest_not_found");
  });

  it("picks stay hidden until entries lock, in API responses and raw table reads", async () => {
    const v = await getContestView(ids.jordan, seed.winBet);
    expect(v.picks_visible).toBe(false);
    const backers = v.outcomes.flatMap((o) => o.backers.map((b) => b.username));
    expect(backers).toEqual(["jordan"]);
    expect(v.outcomes.every((o) => o.count === null)).toBe(true);
    const raw = await asUser(ids.jordan, (q) => q.query("select user_id from public.bet_picks where contest_id = $1", [seed.winBet]));
    expect(raw.map((r) => r.user_id)).toEqual([ids.jordan]);
    // a user who hasn't entered sees no picks
    const rawZ = await asUser(ids.zz, (q) => q.query("select user_id from public.bet_picks where contest_id = $1", [seed.winBet]));
    expect(rawZ).toHaveLength(0);
  });

  it("regular users can't run admin actions or touch protected tables", async () => {
    expect(await code(admin.setStatus(ids.jordan, seed.winBet, "locked"))).toBe("forbidden");
    expect(await code(admin.settlementPreview(ids.jordan, seed.winBet))).toBe("forbidden");
    expect(await code(admin.getAdminContest(ids.jordan, seed.chess))).toBe("admin_only");
    expect(await code(admin.createContest(ids.jordan, { kind: "bet", title: "Sneaky", stake: 1 }))).toBe("forbidden");
    const settle = await code(asUser(ids.jordan, (q) => q.query("select sidebet_private.settle_contest($1,$2,null,'[]','{}','x')", [seed.winBet, ids.jordan])));
    expect(settle).toBe("forbidden");
    const upd = await asUser(ids.jordan, (q) => q.query("update public.profiles set is_admin = true where id = auth.uid() returning id"));
    expect(upd).toHaveLength(0);
    const wal = await asUser(ids.jordan, (q) => q.query("update public.wallets set balance = 99999 where user_id = auth.uid() returning user_id"));
    expect(wal).toHaveLength(0);
    expect(await code(asUser(ids.jordan, (q) => q.query("insert into public.ledger (user_id, kind, amount, balance_after, idempotency_key) values (auth.uid(), 'payout', 1000, 1000, 'hack')")))).toBe("forbidden");
    // admin can't skip the settlement flow either
    expect(await code(asUser(ids.commish, (q) => q.query("update public.contests set status = 'settled' where id = $1", [seed.winBet])))).toBe("use_settlement_flow");
  });
});

describe("joins and terms", () => {
  it("join retry never charges twice (sequential and concurrent)", async () => {
    const cid = await admin.createContest(ids.commish, { kind: "bet", title: "Coin flip", visibility: "public", stake: 30 }, [{ label: "Heads" }, { label: "Tails", color: "violet" }]);
    await admin.setStatus(ids.commish, cid, "open");
    const v = await getContestView(ids.dana, cid);
    const heads = v.outcomes[0].id;
    const before = await balance(ids.dana);
    const results = await Promise.all([1, 2, 3].map(() => joinContest(ids.dana, cid, heads)));
    expect(new Set(results).size).toBe(1);
    expect(await joinContest(ids.dana, cid, heads)).toBe(results[0]);
    expect(await balance(ids.dana)).toBe(before - 30);
    const [{ n }] = await asService((q) => q.query("select count(*)::int as n from public.ledger where user_id = $1 and kind = 'stake' and contest_id = $2", [ids.dana, cid]));
    expect(n).toBe(1);
    // terms locked after first entry
    expect(await code(admin.updateContest(ids.commish, cid, { stake: 99 }))).toBe("terms_locked");
    expect(await code(admin.replaceOutcomes(ids.commish, cid, [{ label: "Edge" }]))).toBe("terms_locked");
  });

  it("can't stake more than the balance", async () => {
    const cid = await admin.createContest(ids.commish, { kind: "bet", title: "Whale bet", visibility: "public", stake: 100000 }, [{ label: "A" }, { label: "B" }]);
    await admin.setStatus(ids.commish, cid, "open");
    const v = await getContestView(ids.eli, cid);
    expect(await code(joinContest(ids.eli, cid, v.outcomes[0].id))).toBe("insufficient_chips");
    const after = await getContestView(ids.eli, cid);
    expect(after.entrants).toHaveLength(0);
  });
});

describe("live draft", () => {
  it("enforces turns, snake order and unique picks", async () => {
    const cid = await admin.createContest(
      ids.commish,
      { kind: "draft", title: "Mini draft", visibility: "public", stake: 10, roster_size: 2, draft_format: "snake", draft_mode: "live" },
      [],
      ["A", "B", "C", "D", "E"].map((name) => ({ name })),
    );
    await asService(async (q) => {
      await q.query("select set_config('sidebet.internal','on',true)");
      await q.query(
        `insert into public.scoring_rulesets (contest_id, version, instructions, rules, status) values ($1, 1, 'x', $2::jsonb, 'approved')`,
        [cid, JSON.stringify({ version: 1, summary: "", scope: [], rules: [{ id: "w", type: "points", label: "Win", points: 1, when: [] }], options: { unseeded: "lowest", forfeits: "count", final_only: true } })],
      );
    });
    await admin.setStatus(ids.commish, cid, "open");
    await joinContest(ids.dana, cid, null);
    await joinContest(ids.eli, cid, null);
    await admin.startDraft(ids.commish, cid, null);
    const pool = (await getContestView(ids.dana, cid)).draft!.pool;
    const id = (n: string) => pool.find((p) => p.name === n)!.id;

    expect(await code(makeDraftPick(ids.eli, cid, id("A")))).toBe("not_your_turn");
    // two simultaneous submissions of the same pick slot: exactly one lands
    const both = await Promise.all([code(makeDraftPick(ids.dana, cid, id("A"), 1)), code(makeDraftPick(ids.dana, cid, id("B"), 1))]);
    expect(both.sort()).toEqual(["ok", "stale_pick"]);
    const taken = (await getContestView(ids.dana, cid)).draft!.picks[0].pool_item_id;
    // eli can't take what dana took
    expect(await code(makeDraftPick(ids.eli, cid, taken))).toBe("already_drafted");
    // and two people racing for the same pick: one wins
    const free = pool.find((p) => p.id !== taken)!.id;
    const race = await Promise.all([code(makeDraftPick(ids.eli, cid, free)), code(makeDraftPick(ids.dana, cid, free))]);
    expect(race.filter((r) => r === "ok")).toHaveLength(1);
    // snake: eli picks twice in a row (pick 2 and 3)
    const v = await getContestView(ids.dana, cid);
    const eliEntry = v.entrants.find((e) => e.username === "eli")!.entry_id;
    expect(v.draft!.on_clock).toBe(eliEntry);
    const left = v.draft!.pool.filter((p) => !p.drafted_by);
    await makeDraftPick(ids.eli, cid, left[0].id);
    await makeDraftPick(ids.dana, cid, left[1].id);
    const done = await getContestView(ids.dana, cid);
    expect(done.contest.status).toBe("active");
    expect(done.draft!.picks.map((p) => p.entry_id)).toEqual([done.draft!.picks[0].entry_id, eliEntry, eliEntry, done.draft!.picks[0].entry_id]);
    expect(await code(makeDraftPick(ids.dana, cid, left[2].id))).toBe("draft_not_live");
  });
});

describe("chess draft scoring pipeline", () => {
  const upset = (status: EventFacts["status"] = "final", winner = "Hana Moriyama"): EventFacts => ({
    event_key: "test-r2-moriyama-okafor", event_type: "match", label: "Moriyama vs Okafor", round: "Round 2", bracket: "main", status,
    participants: [
      { name: "Hana Moriyama", result: status === "final" ? (winner === "Hana Moriyama" ? "win" : "loss") : null },
      { name: "Mira Okafor", result: status === "final" ? (winner === "Mira Okafor" ? "win" : "loss") : null },
    ],
    winner: status === "final" ? winner : null,
  });
  const roster = async (uid: string, name: string) => {
    const v = await getContestView(uid, seed.chess);
    const r = v.rosters.find((x) => x.picks.some((p) => p.name === name))!;
    return { roster: r, pick: r.picks.find((p) => p.name === name)! };
  };

  it("both entrants see the same seeded standings with every pick listed", async () => {
    const a = await getContestView(ids.jordan, seed.chess);
    const b = await getContestView(ids.riley, seed.chess);
    expect(a.rosters.map((r) => [r.username, r.total])).toEqual(b.rosters.map((r) => [r.username, r.total]));
    expect(a.rosters.every((r) => r.picks.length === 4)).toBe(true);
    expect(a.rosters.flatMap((r) => r.picks).some((p) => p.points === 0)).toBe(true);
    // seeded fixture stage 1: Okafor +2 (Jordan); Moriyama (7) beat Dragunov (2) +5 (Riley)
    expect(Object.fromEntries(a.rosters.map((r) => [r.username, r.total]))).toEqual({ jordan: 2, riley: 5 });
    expect(a.ruleset!.instructions).toBe(CHESS_RULES);
  });

  it("an upset adds exactly 5 points to the correct pick and roster; breakdown shows +2 and +3", async () => {
    const before = await roster(ids.jordan, "Hana Moriyama");
    const other = await roster(ids.jordan, "Mira Okafor");
    const res = await processFacts(seed.chess, [upset()], { origin: "manual", approved_by: ids.commish });
    expect(res.counts.new).toBe(1);
    const after = await roster(ids.riley, "Hana Moriyama");
    expect(after.pick.points - before.pick.points).toBe(5);
    expect(after.roster.total - before.roster.total).toBe(5);
    const lines = after.pick.lines.filter((l) => l.event_label === "Moriyama vs Okafor");
    expect(lines.map((l) => [l.label, l.points])).toEqual([["Match win", 2], ["Upset bonus", 3]]);
    const otherAfter = await roster(ids.jordan, "Mira Okafor");
    expect(otherAfter.roster.total).toBe(other.roster.total);
  });

  it("reprocessing the same match adds zero points", async () => {
    const before = await roster(ids.jordan, "Hana Moriyama");
    const res = await processFacts(seed.chess, [upset(), upset()], { origin: "feed" });
    expect(res.counts.unchanged).toBe(1);
    expect(res.counts.new + res.counts.update + res.counts.correction).toBe(0);
    const after = await roster(ids.jordan, "Hana Moriyama");
    expect(after.roster.total).toBe(before.roster.total);
    const [{ n }] = await asService((q) => q.query("select count(*)::int as n from public.score_lines s join public.events e on e.id = s.event_id where e.event_key = 'test-r2-moriyama-okafor'"));
    expect(n).toBe(2);
  });

  it("a corrected result recalculates both rosters and keeps revision history", async () => {
    const hana0 = await roster(ids.jordan, "Hana Moriyama");
    const mira0 = await roster(ids.jordan, "Mira Okafor");
    const res = await processFacts(seed.chess, [upset("final", "Mira Okafor")], { origin: "feed" });
    expect(res.counts.correction).toBe(1);
    const hana1 = await roster(ids.jordan, "Hana Moriyama");
    const mira1 = await roster(ids.jordan, "Mira Okafor");
    expect(hana1.pick.points).toBe(hana0.pick.points - 5);
    expect(mira1.pick.points).toBe(mira0.pick.points + 2); // seed 1 beating seed 7: no upset bonus
    const revs = await asService((q) => q.query("select revision, state from public.event_revisions r join public.events e on e.id = r.event_id where e.event_key = 'test-r2-moriyama-okafor' order by revision"));
    expect(revs.map((r) => r.state)).toEqual(["superseded", "applied"]);
    const v = await getContestView(ids.jordan, seed.chess);
    expect(v.changes[0].kind).toBe("correction");
    expect(v.changes[0].summary).toMatch(/Hana Moriyama -5/);
  });

  it("ambiguous names go to review instead of scoring; mapping them applies points once", async () => {
    const facts: EventFacts = {
      event_key: "test-r3-mensah", event_type: "match", label: "K. Mensah vs Petrov", round: "Round 3", bracket: "main", status: "final",
      participants: [{ name: "K. Mensah", result: "win" }, { name: "Sofia Petrov", result: "loss" }], winner: "K. Mensah",
    };
    const before = await roster(ids.jordan, "Kofi Mensah");
    const res = await processFacts(seed.chess, [facts], { origin: "feed" });
    expect(res.counts.review).toBe(1);
    expect((await roster(ids.jordan, "Kofi Mensah")).pick.points).toBe(before.pick.points);
    // a recheck doesn't open a duplicate review
    expect((await processFacts(seed.chess, [facts], { origin: "feed" })).counts.unchanged).toBe(1);
    const reviews = await asService((q) => q.query("select * from public.review_items where contest_id = $1 and kind = 'ambiguous_name' and status = 'open'", [seed.chess]));
    expect(reviews).toHaveLength(1);
    const kofi = (await getContestView(ids.commish, seed.chess)).draft!.pool.find((p) => p.name === "Kofi Mensah")!;
    await admin.resolveReview(ids.commish, reviews[0].id, "map", { mapping: { "K. Mensah": kofi.id } });
    expect((await roster(ids.jordan, "Kofi Mensah")).pick.points).toBe(before.pick.points + 2);
  });

  it("fixture feed via scheduled check: plate matches don't score, stages update both sides", async () => {
    const [src] = (await admin.getAdminContest(ids.commish, seed.chess)).sources;
    await admin.advanceFixture(ids.commish, src.id, 1);
    const out = await checkContest(seed.chess, "schedule");
    expect(out[0].ok).toBe(true);
    const a = await getContestView(ids.jordan, seed.chess);
    const b = await getContestView(ids.riley, seed.chess);
    expect(a.rosters.map((r) => r.total)).toEqual(b.rosters.map((r) => r.total));
    const plate = a.events.find((e) => e.event_key === "plate-ferreira-dragunov")!;
    expect(plate).toBeTruthy();
    const drag = a.rosters.flatMap((r) => r.picks).find((p) => p.name === "Lev Dragunov")!;
    expect(drag.lines).toHaveLength(0);
    // a failing source keeps the last verified scores
    await asService((q) => q.query("update public.result_sources set config = jsonb_set(config, '{fixture}', '\"missing-file\"') where id = $1", [src.id]));
    const totals = a.rosters.map((r) => r.total);
    const fail = await checkContest(seed.chess, "manual");
    expect(fail[0].ok).toBe(false);
    const c = await getContestView(ids.jordan, seed.chess);
    expect(c.rosters.map((r) => r.total)).toEqual(totals);
    expect(c.contest.last_error).toBeTruthy();
    await asService((q) => q.query("update public.result_sources set config = jsonb_set(config, '{fixture}', '\"northgate-chess\"') where id = $1", [src.id]));
  });

  it("settles winner-take-all; retry can't pay twice; correction after payout goes to review", async () => {
    // resolve any open review items first
    for (const r of (await admin.getAdminContest(ids.commish, seed.chess)).reviews.filter((x) => x.status === "open")) {
      await admin.resolveReview(ids.commish, r.id, "dismiss");
    }
    await admin.setStatus(ids.commish, seed.chess, "awaiting_settlement");
    const p = await admin.settlementPreview(ids.commish, seed.chess);
    expect(p.pot).toBe(100);
    const winner = p.lines.find((l) => l.payout > 0)!;
    const wBefore = await balance(winner.user_id);
    const r1 = await admin.settleContest(ids.commish, seed.chess, null, p.hash);
    expect(r1.result).toBe("settled");
    const r2 = await admin.settleContest(ids.commish, seed.chess, null, p.hash);
    expect(r2.result).toBe("already_settled");
    const concurrent = await Promise.all([1, 2].map(() => asService((q) => q.query("select sidebet_private.settle_contest($1,$2,null,'[]','{}','x') as r", [seed.chess, ids.commish]))));
    expect(concurrent.map((c) => c[0].r)).toEqual(["already_settled", "already_settled"]);
    expect(await balance(winner.user_id)).toBe(wBefore + 100);
    const [{ n }] = await asService((q) => q.query("select count(*)::int as n from public.ledger where contest_id = $1 and kind = 'payout'", [seed.chess]));
    expect(n).toBe(1);

    const correction: EventFacts = {
      event_key: "r1-okafor-ferreira", event_type: "match", label: "Okafor vs Ferreira", round: "Round 1", bracket: "main", status: "final",
      participants: [{ name: "Mira Okafor", result: "loss" }, { name: "Dario Ferreira", result: "win" }], winner: "Dario Ferreira",
    };
    const res = await processFacts(seed.chess, [correction], { origin: "feed" });
    expect(res.counts.review).toBe(1);
    expect(await balance(winner.user_id)).toBe(wBefore + 100);
    const reviews = (await admin.getAdminContest(ids.commish, seed.chess)).reviews.filter((x) => x.kind === "correction_after_payout");
    expect(reviews).toHaveLength(1);
  });
});

describe("normal bets", () => {
  it("shows live context before settlement, then pays the winning side with a tie split", async () => {
    const v0 = await getContestView(ids.casey, seed.winBet);
    expect(v0.contest.live_context?.leader).toBe("Ridgeview Owls");
    expect(v0.contest.live_context?.status).toBe("in_progress");
    expect(v0.contest.proposed_outcome_id).toBeNull();

    await admin.setStatus(ids.commish, seed.winBet, "locked");
    const v1 = await getContestView(ids.casey, seed.winBet);
    expect(v1.picks_visible).toBe(true);
    expect(v1.outcomes.find((o) => o.label === "Comets win")!.backers.map((b) => b.username).sort()).toEqual(["casey", "jordan"]);

    const [src] = (await admin.getAdminContest(ids.commish, seed.winBet)).sources;
    await admin.advanceFixture(ids.commish, src.id, 2); // final, Comets win in OT
    await checkContest(seed.winBet, "manual");
    const v2 = await getContestView(ids.casey, seed.winBet);
    expect(v2.contest.status).toBe("awaiting_settlement");
    expect(v2.outcomes.find((o) => o.id === v2.contest.proposed_outcome_id)!.label).toBe("Comets win");

    const before = { j: await balance(ids.jordan), r: await balance(ids.riley), c: await balance(ids.casey) };
    const p = await admin.settlementPreview(ids.commish, seed.winBet);
    expect(p.pot).toBe(60);
    expect(Object.fromEntries(p.lines.map((l) => [l.username, l.payout]))).toEqual({ jordan: 30, riley: 0, casey: 30 });
    await admin.settleContest(ids.commish, seed.winBet, null, p.hash);
    await admin.settleContest(ids.commish, seed.winBet, null, p.hash);
    expect(await balance(ids.jordan)).toBe(before.j + 30);
    expect(await balance(ids.casey)).toBe(before.c + 30);
    expect(await balance(ids.riley)).toBe(before.r);
  });

  it("settlement confirm must match the previewed payouts", async () => {
    await admin.setStatus(ids.commish, seed.otBet, "locked");
    const [src] = (await admin.getAdminContest(ids.commish, seed.otBet)).sources;
    await admin.advanceFixture(ids.commish, src.id, 2);
    await checkContest(seed.otBet, "manual");
    const p = await admin.settlementPreview(ids.commish, seed.otBet);
    expect(await code(admin.settleContest(ids.commish, seed.otBet, null, "stale-hash"))).toBe("preview_changed");
    expect(Object.fromEntries(p.lines.map((l) => [l.username, l.payout]))).toEqual({ jordan: 0, riley: 20 });
    await admin.settleContest(ids.commish, seed.otBet, null, p.hash);
  });

  it("no winning entries refunds; cancel refunds; neither counts as W/L", async () => {
    const cid = await admin.createContest(ids.commish, { kind: "bet", title: "Long shot", visibility: "public", stake: 15 }, [
      { label: "Rain", resolve_when: [{ fact: "event.winner", op: "eq", value: "Rain" }] },
      { label: "Shine", resolve_when: [{ fact: "event.winner", op: "eq", value: "Shine" }] },
    ]);
    await admin.setStatus(ids.commish, cid, "open");
    const v = await getContestView(ids.dana, cid);
    const rain = v.outcomes.find((o) => o.label === "Rain")!.id;
    const d0 = await balance(ids.dana);
    await joinContest(ids.dana, cid, rain);
    await joinContest(ids.eli, cid, rain);
    await admin.setStatus(ids.commish, cid, "locked");
    await admin.manualApply(ids.commish, cid, [{ event_key: "weather", event_type: "other", status: "final", participants: [{ name: "Shine", result: "win" }, { name: "Rain", result: "loss" }], winner: "Shine" }]);
    const p = await admin.settlementPreview(ids.commish, cid);
    expect(p.lines.every((l) => l.refund === 15 && l.payout === 0)).toBe(true);
    await admin.settleContest(ids.commish, cid, null, p.hash);
    expect(await balance(ids.dana)).toBe(d0);

    const cid2 = await admin.createContest(ids.commish, { kind: "bet", title: "Called off", visibility: "public", stake: 40 }, [{ label: "X" }, { label: "Y" }]);
    await admin.setStatus(ids.commish, cid2, "open");
    const x = (await getContestView(ids.dana, cid2)).outcomes[0].id;
    await joinContest(ids.dana, cid2, x);
    expect(await balance(ids.dana)).toBe(d0 - 40);
    expect((await admin.cancelContest(ids.commish, cid2, "Rained out")).result).toBe("canceled");
    expect((await admin.cancelContest(ids.commish, cid2, "again")).result).toBe("already_canceled");
    expect(await balance(ids.dana)).toBe(d0);
  });
});

describe("custom contest from admin-entered results", () => {
  it("'Josiah won race two' previews, then applies through the same pipeline", async () => {
    const before = await getContestView(ids.jordan, seed.race);
    const josiah0 = before.rosters.flatMap((r) => r.picks).find((p) => p.name === "Josiah")!.points;
    const prev = await admin.manualPreview(ids.commish, seed.race, { text: "Josiah won race two" });
    expect(prev.events[0]).toMatchObject({ event_key: "race-2", winner: "Josiah" });
    expect(prev.plan!.dry_run).toBe(true);
    expect(prev.plan!.items[0].lines).toEqual([expect.objectContaining({ pick_name: "Josiah", points: 5, label: "Finish" })]);
    // preview didn't write anything
    expect((await getContestView(ids.jordan, seed.race)).rosters.flatMap((r) => r.picks).find((p) => p.name === "Josiah")!.points).toBe(josiah0);
    await admin.manualApply(ids.commish, seed.race, prev.events);
    const after = await getContestView(ids.riley, seed.race);
    expect(after.rosters.flatMap((r) => r.picks).find((p) => p.name === "Josiah")!.points).toBe(josiah0 + 5);
  });
});

describe("wallet, history and profile agree", () => {
  it("balance = grants + claims + (payouts + refunds − stakes); profile net matches", async () => {
    for (const u of ["jordan", "riley", "casey", "dana", "eli"]) {
      const w = await getWallet(ids[u]);
      const prof = await getProfile(ids[u], u);
      const [l] = await asService((q) =>
        q.query(
          `select coalesce(sum(amount) filter (where kind in ('starting_grant','free_claim')),0)::int as free,
                  coalesce(sum(amount) filter (where kind in ('stake','payout','refund')),0)::int as contest
             from public.ledger where user_id = $1`,
          [ids[u]],
        ),
      );
      expect(w.balance).toBe(l.free + l.contest);
      const settledEntries = prof.history.filter((h) => h.contest_status === "settled");
      // profile net counts finished contests only (stakes still in play are excluded)
      expect(prof.stats.net_chips).toBe(settledEntries.reduce((s, h) => s + h.payout + h.refund - h.stake, 0));
      const pushes = settledEntries.filter((h) => h.status === "push").length;
      expect(prof.stats.wins + prof.stats.losses + prof.stats.ties + pushes).toBe(settledEntries.length);
    }
    const j = await getProfile(ids.jordan, "jordan");
    expect(j.history.filter((h) => h.contest_status === "canceled").length).toBe(0);
    expect(j.h2h.find((h) => h.username === "riley")).toBeTruthy();
    const d = await getProfile(ids.dana, "dana");
    expect(d.history.filter((h) => h.contest_status === "canceled").length).toBe(1);
    expect(d.stats.wins + d.stats.losses).toBe(0); // the refund-all bet is a push; canceled doesn't count
  });
});
