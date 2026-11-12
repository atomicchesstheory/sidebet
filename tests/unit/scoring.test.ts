import { describe, expect, it } from "vitest";
import { computeStandings, liveContext, resolveOutcome, scoreEvent } from "@/lib/scoring/engine";
import { betPayout, draftPayout, previewHash, splitPot } from "@/lib/scoring/payouts";
import { matchName } from "@/lib/scoring/match";
import { RulesetSchema, type EventFacts } from "@/lib/scoring/schema";
import { demoParseResult, demoProposeRules } from "@/lib/server/ai/demo";
import { proposalFromWire, eventsFromWire } from "@/lib/server/ai/wire";
import { parseEspn, parsePgn } from "@/lib/server/results/adapters";
import { assertPublicUrl, isPrivateIp } from "@/lib/server/results/fetch";
import { ruleExamples } from "@/lib/server/rules-preview";

const chessRules = RulesetSchema.parse({
  scope: [{ fact: "event.bracket", op: "eq", value: "main" }],
  rules: [
    { id: "match_win", type: "points", label: "Match win", points: 2, when: [{ fact: "self.result", op: "eq", value: "win" }] },
    {
      id: "upset_bonus", type: "points", label: "Upset bonus", points: 3,
      when: [{ fact: "self.result", op: "eq", value: "win" }, { fact: "opponent.seed", op: "lt", value_fact: "self.seed" }],
    },
  ],
});

const match = (a: [string, number | null], b: [string, number | null], winner: string, o: Partial<EventFacts> = {}): EventFacts => ({
  event_key: "m1", event_type: "match", status: "final", bracket: "main",
  participants: [{ name: a[0], seed: a[1] }, { name: b[0], seed: b[1] }],
  winner, ...o,
});

describe("scoring engine", () => {
  it("chess upset adds exactly 5 points: +2 match win and +3 upset", () => {
    const lines = scoreEvent(chessRules, match(["Low", 7], ["High", 2], "Low"), new Map([[0, "pLow"], [1, "pHigh"]]));
    expect(lines.map((l) => [l.pool_item_id, l.label, l.points])).toEqual([
      ["pLow", "Match win", 2],
      ["pLow", "Upset bonus", 3],
    ]);
    expect(lines.reduce((s, l) => s + l.points, 0)).toBe(5);
  });
  it("favorite win is just +2; loser gets nothing", () => {
    const lines = scoreEvent(chessRules, match(["High", 1], ["Low", 8], "High"), new Map([[0, "a"], [1, "b"]]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ pool_item_id: "a", points: 2 });
  });
  it("only main-bracket matches count; provisional results score nothing", () => {
    expect(scoreEvent(chessRules, match(["A", 5], ["B", 1], "A", { bracket: "plate" }), new Map([[0, "a"]]))).toEqual([]);
    expect(scoreEvent(chessRules, match(["A", 5], ["B", 1], "A", { status: "in_progress" }), new Map([[0, "a"]]))).toEqual([]);
  });
  it("unseeded handling follows the approved option", () => {
    const facts = match(["Unseeded", null], ["Seed3", 3], "Unseeded");
    const lowest = scoreEvent(chessRules, facts, new Map([[0, "u"]]));
    expect(lowest.reduce((s, l) => s + l.points, 0)).toBe(5);
    const noBonus = RulesetSchema.parse({ ...chessRules, options: { ...chessRules.options, unseeded: "no_bonus" } });
    expect(scoreEvent(noBonus, facts, new Map([[0, "u"]])).reduce((s, l) => s + l.points, 0)).toBe(2);
    // beating an unseeded player is never an upset
    expect(scoreEvent(chessRules, match(["Seed9", 9], ["U", null], "Seed9"), new Map([[0, "s"]])).reduce((s, l) => s + l.points, 0)).toBe(2);
  });
  it("forfeits can be ignored", () => {
    const rs = RulesetSchema.parse({ ...chessRules, options: { ...chessRules.options, forfeits: "ignore" } });
    expect(scoreEvent(rs, match(["A", 2], ["B", 1], "A", { is_forfeit: true }), new Map([[0, "a"]]))).toEqual([]);
  });
  it("placement and stat rules", () => {
    const rs = RulesetSchema.parse({
      rules: [
        { id: "finish", type: "placement", label: "Finish", table: { "1": 5, "2": 3, "3": 1 } },
        { id: "goals", type: "stat", label: "Goals", stat: "goals", points_per: 1.5, per: 1, max: 6 },
      ],
    });
    const lines = scoreEvent(rs, {
      event_key: "r", event_type: "race", status: "final",
      participants: [{ name: "A", place: 1 }, { name: "B", place: 3, stats: { goals: 5 } }],
    }, new Map([[0, "a"], [1, "b"]]));
    expect(lines.map((l) => [l.pool_item_id, l.points])).toEqual([["a", 5], ["b", 1], ["b", 6]]);
  });
  it("standings keep zero-point picks, rank, and detect ties", () => {
    const s = computeStandings({
      entries: [{ id: "e1", user_id: "u1", seat: 1, joined_at: "2026-01-01" }, { id: "e2", user_id: "u2", seat: 2, joined_at: "2026-01-02" }],
      picks: [{ entry_id: "e1", pool_item_id: "a", pick_no: 1 }, { entry_id: "e2", pool_item_id: "b", pick_no: 2 }, { entry_id: "e1", pool_item_id: "c", pick_no: 3 }],
      lines: [{ pool_item_id: "a", points: 4 }, { pool_item_id: "b", points: 4 }],
      adjustments: [],
      tiebreakers: ["total_points"],
    });
    expect(s.map((r) => [r.entry_id, r.total, r.place, r.tied])).toEqual([["e1", 4, 1, true], ["e2", 4, 1, true]]);
    expect(s[0].pick_totals).toEqual({ a: 4, c: 0 });
  });
});

describe("payouts", () => {
  const e = (id: string, outcome: string, t: number, stake = 20) => ({ id, user_id: "u" + id, stake, joined_at: new Date(t).toISOString(), outcome_id: outcome });
  it("equal split with published leftover rule (earliest entries first)", () => {
    const r = betPayout([e("a", "X", 3), e("b", "X", 1), e("c", "Y", 2), e("d", "X", 4)], "X");
    expect(r.pot).toBe(80);
    const by = Object.fromEntries(r.lines.map((l) => [l.entry_id, l.payout]));
    expect(by).toEqual({ a: 27, b: 27, c: 0, d: 26 });
    expect(r.lines.reduce((s, l) => s + l.payout + l.refund, 0)).toBe(80);
  });
  it("nobody on the winning side refunds everyone", () => {
    const r = betPayout([e("a", "X", 1), e("b", "X", 2)], "Y");
    expect(r.kind).toBe("refund_all");
    expect(r.lines.every((l) => l.refund === 20 && l.payout === 0 && l.status === "push")).toBe(true);
  });
  it("draft winner takes all; ties split", () => {
    const base = (id: string, place: number) => ({ id, user_id: id, stake: 50, joined_at: "2026-01-01", place, points: 0 });
    expect(draftPayout([base("a", 1), base("b", 2)]).lines.map((l) => l.payout)).toEqual([100, 0]);
    const tie = draftPayout([base("a", 1), base("b", 1), base("c", 3)]);
    expect(tie.lines.map((l) => [l.payout, l.status])).toEqual([[75, "tied"], [75, "tied"], [0, "lost"]]);
  });
  it("split pot sums exactly; preview hash is stable and sensitive", () => {
    const m = splitPot(101, [e("a", "", 1), e("b", "", 2), e("c", "", 3)]);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(101);
    const r = betPayout([e("a", "X", 1), e("b", "Y", 2)], "X");
    expect(previewHash("X", r)).toBe(previewHash("X", r));
    expect(previewHash("Y", r)).not.toBe(previewHash("X", r));
  });
});

describe("matching", () => {
  const pool = [
    { id: "1", name: "Mira Okafor", aliases: [] },
    { id: "2", name: "Kofi Mensah", aliases: ["The Lion"] },
    { id: "3", name: "José Núñez", aliases: [] },
  ];
  it("exact, alias, accents and 'Last, First'", () => {
    expect(matchName("mira okafor", pool)).toEqual({ status: "matched", id: "1" });
    expect(matchName("The Lion", pool)).toEqual({ status: "matched", id: "2" });
    expect(matchName("Jose Nunez", pool)).toEqual({ status: "matched", id: "3" });
    expect(matchName("Okafor, Mira", pool)).toEqual({ status: "matched", id: "1" });
  });
  it("close names go to review, strangers are ignored", () => {
    expect(matchName("M. Okafor", pool).status).toBe("ambiguous");
    expect(matchName("Mira Okafur", pool).status).toBe("ambiguous");
    expect(matchName("Somebody Else", pool).status).toBe("none");
  });
});

describe("bet resolution and live context", () => {
  const outcomes = [
    { id: "yes", resolve_when: [{ fact: "event.overtime", op: "true" as const }] },
    { id: "no", resolve_when: [{ fact: "event.overtime", op: "false" as const }] },
  ];
  const game = (status: EventFacts["status"], ot: boolean): EventFacts => ({
    event_key: "g", event_type: "game", status, attributes: { overtime: ot },
    participants: [{ name: "Comets", score: 96 }, { name: "Owls", score: 98 }],
  });
  it("stays pending until final", () => {
    expect(resolveOutcome(outcomes, game("in_progress", true)).outcome_id).toBeNull();
    expect(resolveOutcome(outcomes, game("final", true)).outcome_id).toBe("yes");
    expect(resolveOutcome(outcomes, game("final", false)).outcome_id).toBe("no");
  });
  it("live context shows who is ahead", () => {
    const l = liveContext(game("in_progress", false));
    expect(l.leader).toBe("Owls");
    expect(l.tied).toBe(false);
  });
});

describe("demo AI parser (deterministic fixtures)", () => {
  it("parses the chess instructions into +2 / +3 / main bracket and asks about forfeits + unseeded", () => {
    const w = demoProposeRules("Each drafted player gets 2 points for a match win and 3 extra if they beat a higher seed. Only main-bracket matches count.");
    const r = proposalFromWire(w);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.ruleset.rules.map((x) => [x.id, x.type === "points" ? x.points : null])).toEqual([["match_win", 2], ["upset_bonus", 3]]);
    expect(r.proposal.ruleset.scope).toEqual([{ fact: "event.bracket", op: "eq", value: "main" }]);
    expect(r.proposal.questions.map((q) => q.id).sort()).toEqual(["bracket", "forfeits", "unseeded"]);
    const ex = ruleExamples(r.proposal.ruleset, []);
    const upset = ex.find((x) => x.title === "Upset")!;
    expect(upset.results[0].total).toBe(5);
    expect(upset.results[0].lines).toEqual([{ label: "Match win", points: 2 }, { label: "Upset bonus", points: 3 }]);
    expect(ex.find((x) => x.title.startsWith("Outside"))!.note).toMatch(/Scores nothing/);
  });
  it("flags what it can't represent", () => {
    const r = proposalFromWire(demoProposeRules("2 points for a match win. Double points if it's raining."));
    expect(r.ok && r.proposal.unsupported.map((u) => u.text)).toEqual(["Double points if it's raining."]);
  });
  it("parses 'Josiah won race two'", () => {
    const { events } = eventsFromWire(demoParseResult("Josiah won race two"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_key: "race-2", event_type: "race", status: "final", winner: "Josiah" });
    expect(events[0].participants[0]).toMatchObject({ name: "Josiah", place: 1 });
  });
  it("parses placements and head-to-head results", () => {
    expect(eventsFromWire(demoParseResult("Mara finished 2nd in race 3")).events[0]).toMatchObject({ event_key: "race-3" });
    expect(eventsFromWire(demoParseResult("Okafor beat Lindqvist 2-1 in round 3")).events[0]).toMatchObject({ winner: "Okafor", round: "round 3" });
  });
});

describe("structured feed adapters", () => {
  it("PGN games become facts with stable keys", () => {
    const pgn = `[Event "Open"]\n[Round "2.1"]\n[White "Carlsen, Magnus"]\n[Black "Nakamura, Hikaru"]\n[Result "0-1"]\n\n1. e4 e5 0-1\n\n[Event "Open"]\n[Round "2.2"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. d4 *`;
    const f = parsePgn(pgn);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ status: "final", winner: "Nakamura, Hikaru", round: "Round 2.1" });
    expect(f[1].status).toBe("in_progress");
    expect(parsePgn(pgn)[0].event_key).toBe(f[0].event_key);
  });
  it("ESPN scoreboard JSON", () => {
    const f = parseEspn({
      events: [{ id: "401", shortName: "BOS @ NYK", status: { period: 4, displayClock: "0:00", type: { state: "post", completed: true, shortDetail: "Final" } },
        competitions: [{ competitors: [{ homeAway: "home", score: "110", winner: true, team: { displayName: "New York Knicks" } }, { homeAway: "away", score: "99", winner: false, team: { displayName: "Boston Celtics" } }] }] }],
    });
    expect(f[0]).toMatchObject({ event_key: "espn:401", status: "final", winner: "New York Knicks" });
    expect(f[0].participants[0].name).toBe("Boston Celtics");
  });
});

describe("URL safety", () => {
  it("blocks private and local targets", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    await expect(assertPublicUrl("http://localhost:3000/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://169.254.169.254/latest")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://user:pw@example.com/")).rejects.toThrow();
  });
});
