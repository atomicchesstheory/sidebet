import { z } from "zod";
import {
  EventFactsSchema,
  RuleProposalSchema,
  type EventFacts,
  type RuleProposal,
} from "../../scoring/schema";

/**
 * Flat "wire" schemas for model output (structured-output friendly: no
 * records, everything required/nullable). Converted to the strict internal
 * schemas and re-validated before anything uses them.
 */
const Op = z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "missing", "true", "false"]);
const WireCondition = z.object({
  fact: z.string().describe("event.round | event.bracket | event.is_forfeit | event.<attribute> | self.result | self.seed | self.place | self.stats.<stat> | opponent.seed | opponent.result"),
  op: Op,
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  value_list: z.array(z.string()).nullable(),
  value_fact: z.string().nullable().describe("compare to another fact, e.g. self.seed"),
});
const WireRule = z.object({
  id: z.string().describe("snake_case id"),
  type: z.enum(["points", "placement", "stat"]),
  label: z.string().describe("short label shown in the breakdown, e.g. 'Match win'"),
  points: z.number().nullable(),
  placement: z.array(z.object({ place: z.number().int(), points: z.number() })).nullable(),
  stat: z.string().nullable(),
  points_per: z.number().nullable(),
  per: z.number().nullable(),
  max: z.number().nullable(),
  when: z.array(WireCondition),
});
export const WireProposal = z.object({
  summary: z.string(),
  scope: z.array(WireCondition),
  rules: z.array(WireRule),
  options: z.object({
    unseeded: z.enum(["lowest", "no_bonus"]),
    forfeits: z.enum(["count", "ignore"]),
    final_only: z.boolean(),
  }),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      why: z.string(),
      options: z.array(z.string()),
      option_key: z.enum(["unseeded", "forfeits", "final_only"]).nullable(),
    }),
  ),
  unsupported: z.array(z.object({ text: z.string(), reason: z.string() })),
});
export type WireProposal = z.infer<typeof WireProposal>;

const WireParticipant = z.object({
  name: z.string(),
  seed: z.number().int().nullable(),
  score: z.string().nullable(),
  place: z.number().int().nullable(),
  result: z.enum(["win", "loss", "draw"]).nullable(),
  stats: z.array(z.object({ name: z.string(), value: z.number() })),
});
export const WireEvents = z.object({
  events: z.array(
    z.object({
      event_key: z.string().describe("stable id for the match/game/race, e.g. 'r3-board2' or the source's match id"),
      event_type: z.enum(["match", "game", "race", "round", "other"]),
      label: z.string(),
      round: z.string().nullable(),
      bracket: z.string().nullable(),
      status: z.enum(["scheduled", "in_progress", "final"]),
      winner: z.string().nullable(),
      is_forfeit: z.boolean(),
      participants: z.array(WireParticipant),
      attributes: z.array(z.object({ key: z.string(), value: z.string() })),
      evidence: z.string().describe("short verbatim quote from the source supporting this result"),
    }),
  ),
  notes: z.string(),
});
export type WireEvents = z.infer<typeof WireEvents>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "x";

function cond(c: z.infer<typeof WireCondition>) {
  const out: Record<string, unknown> = { fact: c.fact, op: c.op };
  if (c.value_fact) out.value_fact = c.value_fact;
  else if (c.value_list && (c.op === "in" || c.op === "not_in")) out.value = c.value_list;
  else if (c.value !== null && c.value !== undefined) out.value = c.value;
  return out;
}

/** Convert + strictly validate. Returns errors instead of throwing so the admin can edit. */
export function proposalFromWire(w: WireProposal): { ok: true; proposal: RuleProposal } | { ok: false; errors: string[] } {
  const rules = w.rules.map((r) => {
    const base = { id: slug(r.id), label: r.label.slice(0, 60), when: r.when.map(cond) };
    if (r.type === "placement")
      return { ...base, type: "placement", table: Object.fromEntries((r.placement ?? []).map((p) => [String(p.place), p.points])) };
    if (r.type === "stat")
      return { ...base, type: "stat", stat: slug(r.stat ?? "stat"), points_per: r.points_per ?? 0, per: r.per && r.per > 0 ? r.per : 1, ...(r.max != null ? { max: r.max } : {}) };
    return { ...base, type: "points", points: r.points ?? 0 };
  });
  const parsed = RuleProposalSchema.safeParse({
    ruleset: { version: 1, summary: w.summary.slice(0, 500), scope: w.scope.map(cond), rules, options: w.options },
    questions: w.questions.map((q) => ({ ...q, id: slug(q.id), option_key: q.option_key ?? undefined })),
    unsupported: w.unsupported,
  });
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  return { ok: true, proposal: parsed.data };
}

export function eventsFromWire(w: WireEvents): { events: EventFacts[]; rejected: { event_key: string; errors: string[] }[] } {
  const events: EventFacts[] = [];
  const rejected: { event_key: string; errors: string[] }[] = [];
  for (const e of w.events) {
    const candidate = {
      event_key: e.event_key,
      event_type: e.event_type,
      label: e.label || undefined,
      round: e.round,
      bracket: e.bracket,
      status: e.status,
      winner: e.winner,
      is_forfeit: e.is_forfeit,
      evidence: e.evidence?.slice(0, 2000),
      participants: e.participants.map((p) => ({
        name: p.name,
        seed: p.seed && p.seed > 0 ? p.seed : null,
        score: p.score,
        place: p.place && p.place > 0 ? p.place : null,
        result: p.result,
        ...(p.stats.length ? { stats: Object.fromEntries(p.stats.map((s) => [slug(s.name), s.value])) } : {}),
      })),
      ...(e.attributes.length
        ? {
            attributes: Object.fromEntries(
              e.attributes.map((a) => {
                const v = a.value;
                const coerced = v === "true" ? true : v === "false" ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
                return [slug(a.key), coerced];
              }),
            ),
          }
        : {}),
    };
    const parsed = EventFactsSchema.safeParse(candidate);
    if (parsed.success) events.push(parsed.data);
    else rejected.push({ event_key: e.event_key, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  return { events, rejected };
}
