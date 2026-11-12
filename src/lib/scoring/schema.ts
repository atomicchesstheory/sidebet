import { z } from "zod";

/**
 * Structured scoring rules + event facts. Everything that comes from an AI
 * model or a results source is parsed with these schemas before use.
 */

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const ConditionSchema = z
  .object({
    /** Path into the scoring context: event.round, event.bracket, self.result, self.seed, opponent.seed, self.stats.goals … */
    fact: z.string().min(3).max(80).regex(/^(event|self|opponent)\.[a-z0-9_.]+$/),
    op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "missing", "true", "false"]),
    value: z.union([Scalar, z.array(z.union([z.string(), z.number()]))]).optional(),
    /** Compare against another fact instead of a literal (e.g. opponent.seed < self.seed). */
    value_fact: z
      .string()
      .regex(/^(event|self|opponent)\.[a-z0-9_.]+$/)
      .optional(),
  })
  .strict();
export type Condition = z.infer<typeof ConditionSchema>;

const RuleBase = {
  id: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/),
  label: z.string().min(1).max(60),
  when: z.array(ConditionSchema).max(10).default([]),
};

export const RuleSchema = z.discriminatedUnion("type", [
  /** Fixed points per event, optionally conditional (bonuses are just conditional points). */
  z.object({ ...RuleBase, type: z.literal("points"), points: z.number().min(-1000).max(1000) }).strict(),
  /** Placement scoring: { "1": 5, "2": 3, "3": 1 }. */
  z
    .object({
      ...RuleBase,
      type: z.literal("placement"),
      table: z.record(z.string().regex(/^[0-9]+$/), z.number().min(-1000).max(1000)),
    })
    .strict(),
  /** Points from a numerical stat: points_per × floor(stat / per), optionally capped. */
  z
    .object({
      ...RuleBase,
      type: z.literal("stat"),
      stat: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/),
      points_per: z.number().min(-1000).max(1000),
      per: z.number().positive().default(1),
      max: z.number().optional(),
    })
    .strict(),
]);
export type Rule = z.infer<typeof RuleSchema>;

export const RuleOptionsSchema = z
  .object({
    /** How missing seeds compare: 'lowest' = unseeded ranks below every seed; 'no_bonus' = seed comparisons with an unseeded player are false. */
    unseeded: z.enum(["lowest", "no_bonus"]).default("lowest"),
    /** Whether forfeits / walkovers score like normal results. */
    forfeits: z.enum(["count", "ignore"]).default("count"),
    /** Only final results score (provisional results are shown but score nothing). */
    final_only: z.boolean().default(true),
  })
  .strict();

export const RulesetSchema = z
  .object({
    version: z.literal(1).default(1),
    summary: z.string().max(500).default(""),
    /** Event-level filters every rule shares (e.g. only main-bracket matches). */
    scope: z.array(ConditionSchema).max(10).default([]),
    rules: z.array(RuleSchema).min(1).max(30),
    options: RuleOptionsSchema.default({ unseeded: "lowest", forfeits: "count", final_only: true }),
  })
  .strict();
export type Ruleset = z.infer<typeof RulesetSchema>;

export const UnsupportedSchema = z.object({
  text: z.string().max(400),
  reason: z.string().max(400),
});
export const QuestionSchema = z.object({
  id: z.string().max(40),
  question: z.string().max(400),
  why: z.string().max(400).default(""),
  options: z.array(z.string().max(80)).max(6).default([]),
  /** If the answer maps to a rule option, which one. */
  option_key: z.enum(["unseeded", "forfeits", "final_only"]).optional(),
});
export type RuleQuestion = z.infer<typeof QuestionSchema>;

export const RuleProposalSchema = z.object({
  ruleset: RulesetSchema,
  questions: z.array(QuestionSchema).max(8).default([]),
  unsupported: z.array(UnsupportedSchema).max(10).default([]),
});
export type RuleProposal = z.infer<typeof RuleProposalSchema>;

// ------------------------------------------------------------- event facts --

export const ParticipantSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    seed: z.number().int().positive().nullable().optional(),
    score: z.union([z.number(), z.string().max(20)]).nullable().optional(),
    place: z.number().int().positive().nullable().optional(),
    result: z.enum(["win", "loss", "draw"]).nullable().optional(),
    stats: z.record(z.string().regex(/^[a-z0-9_]+$/), z.number()).optional(),
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const EventFactsSchema = z
  .object({
    event_key: z.string().trim().min(1).max(200),
    event_type: z.enum(["match", "game", "race", "round", "other"]).default("match"),
    label: z.string().max(160).optional(),
    round: z.string().max(60).nullable().optional(),
    bracket: z.string().max(60).nullable().optional(),
    status: z.enum(["scheduled", "in_progress", "final"]),
    participants: z.array(ParticipantSchema).min(1).max(64),
    winner: z.string().max(80).nullable().optional(),
    is_forfeit: z.boolean().optional(),
    attributes: z.record(z.string().regex(/^[a-z0-9_]+$/), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])).optional(),
    evidence: z.string().max(2000).optional(),
  })
  .strict();
export type EventFacts = z.infer<typeof EventFactsSchema>;

/** Bet outcome resolution conditions, evaluated against an event's facts. */
export const ResolveWhenSchema = z.array(ConditionSchema).max(10);
