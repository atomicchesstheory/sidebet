import type { Condition, EventFacts, Participant, Rule, Ruleset } from "./schema";

/**
 * Pure scoring. Application code — never the model — turns verified facts
 * into points using the approved ruleset.
 */

export type ScoreLineDraft = {
  pool_item_id: string;
  rule_id: string;
  label: string;
  points: number;
  detail: string;
};

type Ctx = {
  event: Record<string, unknown>;
  self: Record<string, unknown>;
  opponent: Record<string, unknown> | null;
};

/** Fill in per-participant results from `winner` when the source only names the winner. */
export function normalizeFacts(f: EventFacts): EventFacts {
  const participants = f.participants.map((p) => ({ ...p }));
  if (f.winner && f.status === "final") {
    const w = normName(f.winner);
    const hasWinner = participants.some((p) => normName(p.name) === w);
    if (hasWinner) {
      for (const p of participants) {
        if (p.result == null) p.result = normName(p.name) === w ? "win" : "loss";
      }
    }
  }
  if (!f.winner && f.status === "final") {
    const winners = participants.filter((p) => p.result === "win");
    if (winners.length === 1) return { ...f, participants, winner: winners[0].name };
  }
  return { ...f, participants };
}

export function normName(s: string): string {
  let t = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // "Last, First" -> "First Last"
  const comma = t.match(/^\s*([^,]+),\s*([^,]+)\s*$/);
  if (comma) t = `${comma[2]} ${comma[1]}`;
  return t
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function participantCtx(p: Participant): Record<string, unknown> {
  return {
    name: p.name,
    seed: p.seed ?? null,
    score: p.score ?? null,
    place: p.place ?? null,
    result: p.result ?? null,
    won: p.result === "win",
    stats: p.stats ?? {},
  };
}

function eventCtx(f: EventFacts): Record<string, unknown> {
  return {
    event_key: f.event_key,
    event_type: f.event_type,
    round: f.round ?? null,
    bracket: f.bracket ?? null,
    status: f.status,
    winner: f.winner ?? null,
    is_forfeit: f.is_forfeit ?? false,
    participant_count: f.participants.length,
    ...(f.attributes ?? {}),
    attributes: f.attributes ?? {},
  };
}

function lookup(ctx: Ctx, path: string): unknown {
  const [root, ...rest] = path.split(".");
  let cur: unknown = (ctx as Record<string, unknown>)[root];
  for (const k of rest) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function isSeedPath(path: string) {
  return path.endsWith(".seed");
}

function cmpValue(v: unknown, path: string, unseeded: "lowest" | "no_bonus"): unknown {
  if ((v === null || v === undefined) && isSeedPath(path) && unseeded === "lowest") return Number.POSITIVE_INFINITY;
  return v;
}

function eq(a: unknown, b: unknown) {
  if (typeof a === "string" && typeof b === "string") return normName(a) === normName(b);
  return a === b;
}

export function evalCondition(c: Condition, ctx: Ctx, unseeded: "lowest" | "no_bonus" = "lowest"): boolean {
  const raw = lookup(ctx, c.fact);
  const left = cmpValue(raw, c.fact, unseeded);
  const right = c.value_fact ? cmpValue(lookup(ctx, c.value_fact), c.value_fact, unseeded) : c.value;
  switch (c.op) {
    case "exists":
      return raw !== null && raw !== undefined;
    case "missing":
      return raw === null || raw === undefined;
    case "true":
      return raw === true;
    case "false":
      return raw === false || raw === null || raw === undefined;
    case "eq":
      return eq(left, right);
    case "neq":
      return !eq(left, right);
    case "in":
      return Array.isArray(right) && right.some((r) => eq(left, r));
    case "not_in":
      return Array.isArray(right) && !right.some((r) => eq(left, r));
    default: {
      if (typeof left !== "number" || typeof right !== "number") return false;
      if (!Number.isFinite(left) && !Number.isFinite(right)) return false; // both unseeded
      if (c.op === "gt") return left > right;
      if (c.op === "gte") return left >= right;
      if (c.op === "lt") return left < right;
      return left <= right;
    }
  }
}

function describe(c: Condition): string {
  const rhs = c.value_fact ?? JSON.stringify(c.value);
  return ["exists", "missing", "true", "false"].includes(c.op) ? `${c.fact} ${c.op}` : `${c.fact} ${c.op} ${rhs}`;
}

/** Event-level check: does this event count at all under the ruleset? */
export function eventInScope(rs: Ruleset, facts: EventFacts): { ok: boolean; reason?: string } {
  const ctx: Ctx = { event: eventCtx(facts), self: {}, opponent: null };
  if (rs.options.final_only && facts.status !== "final") return { ok: false, reason: "not final yet" };
  if (facts.is_forfeit && rs.options.forfeits === "ignore") return { ok: false, reason: "forfeits don't count" };
  for (const c of rs.scope) {
    if (!evalCondition(c, ctx, rs.options.unseeded)) return { ok: false, reason: `out of scope (${describe(c)})` };
  }
  return { ok: true };
}

function ruleValue(rule: Rule, self: Participant): number {
  if (rule.type === "points") return rule.points;
  if (rule.type === "placement") return self.place ? (rule.table[String(self.place)] ?? 0) : 0;
  const stat = self.stats?.[rule.stat];
  if (typeof stat !== "number") return 0;
  let pts = Math.floor(stat / rule.per) * rule.points_per;
  if (rule.max !== undefined) pts = Math.min(pts, rule.max);
  return Math.round(pts * 100) / 100;
}

/**
 * Score one event. `matched` maps participant index -> pool item id for the
 * participants that are drafted picks in this contest.
 */
export function scoreEvent(rs: Ruleset, rawFacts: EventFacts, matched: Map<number, string>): ScoreLineDraft[] {
  const facts = normalizeFacts(rawFacts);
  if (!eventInScope(rs, facts).ok) return [];
  const lines: ScoreLineDraft[] = [];
  const two = facts.participants.length === 2;
  facts.participants.forEach((p, i) => {
    const poolId = matched.get(i);
    if (!poolId) return;
    const opp = two ? facts.participants[1 - i] : null;
    const ctx: Ctx = { event: eventCtx(facts), self: participantCtx(p), opponent: opp ? participantCtx(opp) : null };
    for (const rule of rs.rules) {
      if (!rule.when.every((c) => evalCondition(c, ctx, rs.options.unseeded))) continue;
      const pts = ruleValue(rule, p);
      if (pts === 0) continue;
      const vs = opp ? ` vs ${opp.name}${opp.seed ? ` (seed ${opp.seed})` : ""}` : "";
      lines.push({
        pool_item_id: poolId,
        rule_id: rule.id,
        label: rule.label,
        points: pts,
        detail: `${facts.label ?? facts.event_key}${facts.round ? ` · ${facts.round}` : ""}${vs}`,
      });
    }
  });
  return lines;
}

// ------------------------------------------------------------- standings --

export type StandingsInput = {
  entries: { id: string; user_id: string; seat: number; joined_at: string | Date }[];
  picks: { entry_id: string; pool_item_id: string; pick_no: number }[];
  lines: { pool_item_id: string | null; points: number }[];
  adjustments: { pool_item_id: string | null; entry_id: string | null; points: number }[];
  tiebreakers: string[];
};

export type Standing = {
  entry_id: string;
  total: number;
  best_pick: number;
  place: number;
  tied: boolean;
  pick_totals: Record<string, number>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeStandings(inp: StandingsInput): Standing[] {
  const perPick = new Map<string, number>();
  for (const l of inp.lines) if (l.pool_item_id) perPick.set(l.pool_item_id, round2((perPick.get(l.pool_item_id) ?? 0) + Number(l.points)));
  for (const a of inp.adjustments) if (a.pool_item_id) perPick.set(a.pool_item_id, round2((perPick.get(a.pool_item_id) ?? 0) + Number(a.points)));
  const rows = inp.entries.map((e) => {
    const mine = inp.picks.filter((p) => p.entry_id === e.id);
    const pick_totals: Record<string, number> = {};
    for (const p of mine) pick_totals[p.pool_item_id] = perPick.get(p.pool_item_id) ?? 0;
    const entryAdj = inp.adjustments.filter((a) => a.entry_id === e.id && !a.pool_item_id).reduce((s, a) => s + Number(a.points), 0);
    const total = round2(Object.values(pick_totals).reduce((s, v) => s + v, 0) + entryAdj);
    const best_pick = Object.values(pick_totals).reduce((m, v) => Math.max(m, v), 0);
    return { entry_id: e.id, total, best_pick, pick_totals, place: 0, tied: false };
  });
  const key = (r: (typeof rows)[number]) =>
    [r.total, ...(inp.tiebreakers.includes("best_pick") ? [r.best_pick] : [])] as number[];
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  for (const r of rows) {
    const k = key(r);
    r.place = 1 + rows.filter((o) => better(key(o), k)).length;
  }
  for (const r of rows) r.tied = rows.some((o) => o !== r && o.place === r.place);
  return rows.sort((a, b) => a.place - b.place || b.total - a.total);
}

// -------------------------------------------------------- bet resolution --

/** Which outcome do these facts resolve to? Only final events resolve. */
export function resolveOutcome(
  outcomes: { id: string; resolve_when: Condition[] }[],
  rawFacts: EventFacts,
): { outcome_id: string | null; ambiguous: boolean } {
  const facts = normalizeFacts(rawFacts);
  if (facts.status !== "final") return { outcome_id: null, ambiguous: false };
  const ctx: Ctx = { event: eventCtx(facts), self: {}, opponent: null };
  const hits = outcomes.filter((o) => o.resolve_when.length > 0 && o.resolve_when.every((c) => evalCondition(c, ctx)));
  if (hits.length === 1) return { outcome_id: hits[0].id, ambiguous: false };
  return { outcome_id: null, ambiguous: hits.length > 1 };
}

/** Live context for a bet: scores, leader, status. */
export function liveContext(rawFacts: EventFacts) {
  const facts = normalizeFacts(rawFacts);
  const ps = facts.participants.map((p) => ({ name: p.name, score: p.score ?? null, seed: p.seed ?? null }));
  let leader: string | null = null;
  const nums = ps.map((p) => (typeof p.score === "number" ? p.score : Number(p.score)));
  if (ps.length === 2 && nums.every((n) => Number.isFinite(n))) {
    if (nums[0] !== nums[1]) leader = nums[0] > nums[1] ? ps[0].name : ps[1].name;
  }
  return {
    event_key: facts.event_key,
    label: facts.label ?? facts.event_key,
    status: facts.status,
    participants: ps,
    leader,
    tied: ps.length === 2 && leader === null && nums.every((n) => Number.isFinite(n)),
    winner: facts.winner ?? null,
    attributes: facts.attributes ?? {},
    round: facts.round ?? null,
  };
}
export type LiveContext = ReturnType<typeof liveContext>;
