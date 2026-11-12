import { z } from "zod";
import { config } from "./config";
import { asService, asUser, num, type Q } from "./db";
import { AppError } from "./errors";
import { notifyContest } from "./live";
import { parseManualResult, proposeRules } from "./ai";
import { ruleExamples } from "./rules-preview";
import { readSource, type SourceRow, fixtureNames } from "./results/adapters";
import { aiContextFor, checkContest, processFacts } from "./results/pipeline";
import { assertPublicUrl } from "./results/fetch";
import { betPayout, draftPayout, previewHash, type PayoutEntry } from "../scoring/payouts";
import { computeStandings } from "../scoring/engine";
import { ConditionSchema, EventFactsSchema, RulesetSchema, type EventFacts, type Ruleset } from "../scoring/schema";

// ----------------------------------------------------------- contest setup --
export const ContestInput = z.object({
  kind: z.enum(["bet", "draft"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().max(2000).default(""),
  category: z.enum(["chess", "sports", "custom"]).default("custom"),
  visibility: z.enum(["public", "private"]).default("private"),
  stake: z.number().int().min(0).max(100000),
  max_entrants: z.number().int().min(2).max(64).nullable().default(null),
  lock_at: z.string().datetime({ offset: true }).nullable().default(null),
  pick_visibility: z.enum(["after_lock", "always"]).default("after_lock"),
  terms_text: z.string().max(2000).default(""),
  roster_size: z.number().int().min(1).max(30).nullable().default(null),
  draft_format: z.enum(["snake", "straight"]).nullable().default(null),
  draft_mode: z.enum(["live", "offline"]).nullable().default(null),
  resolution: z.object({ event_key: z.string().max(200).optional(), label: z.string().max(160).optional() }).default({}),
  request_id: z.string().uuid().nullable().default(null),
});
export type ContestInput = z.infer<typeof ContestInput>;

export const OutcomeInput = z.object({
  label: z.string().trim().min(1).max(80),
  color: z.enum(["teal", "violet", "lime", "amber", "rose", "sky"]).default("teal"),
  resolve_when: z.array(ConditionSchema).max(10).default([]),
});
export const PoolInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["player", "team", "other"]).default("player"),
  seed: z.number().int().positive().nullable().default(null),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
});

export async function createContest(adminId: string, raw: unknown, outcomes: unknown[] = [], pool: unknown[] = []) {
  const c = ContestInput.parse(raw);
  if (c.kind === "draft" && (!c.roster_size || !c.draft_format || !c.draft_mode)) throw new AppError("validation", "Drafts need roster size, format and mode.");
  const id = await asUser(adminId, async (q) => {
    const [row] = await q.query<{ id: string }>(
      `insert into public.contests (kind, title, description, category, visibility, stake, max_entrants, lock_at, pick_visibility,
         payout_rule, terms_text, roster_size, draft_format, draft_mode, resolution, created_by, request_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb, auth.uid(), $16) returning id`,
      [c.kind, c.title, c.description, c.category, c.visibility, c.stake, c.max_entrants, c.lock_at, c.pick_visibility,
       c.kind === "bet" ? "equal_split_winners" : "winner_take_all", c.terms_text, c.roster_size, c.draft_format, c.draft_mode,
       JSON.stringify(c.resolution), c.request_id],
    );
    await insertOutcomes(q, row.id, outcomes);
    await upsertPool(q, row.id, pool);
    if (c.request_id) {
      await q.query("update public.contest_requests set status = 'converted', contest_id = $2, updated_at = now() where id = $1", [c.request_id, row.id]);
    }
    return row.id;
  });
  return id;
}

async function insertOutcomes(q: Q, contestId: string, outcomes: unknown[]) {
  const list = z.array(OutcomeInput).max(12).parse(outcomes);
  let i = 0;
  for (const o of list) {
    await q.query("insert into public.contest_outcomes (contest_id, label, color, sort_order, resolve_when) values ($1,$2,$3,$4,$5::jsonb)", [
      contestId, o.label, o.color, i++, JSON.stringify(o.resolve_when),
    ]);
  }
}

async function upsertPool(q: Q, contestId: string, pool: unknown[]) {
  const list = z.array(PoolInput).max(300).parse(pool);
  for (const p of list) {
    await q.query(
      `insert into public.pool_items (contest_id, name, kind, seed, aliases) values ($1,$2,$3,$4,$5)
       on conflict (contest_id, name) do update set kind = excluded.kind, seed = excluded.seed, aliases = excluded.aliases`,
      [contestId, p.name, p.kind, p.seed, p.aliases],
    );
  }
}

export async function updateContest(adminId: string, id: string, raw: unknown) {
  const patch = ContestInput.partial().parse(raw);
  const cols = Object.entries(patch).filter(([k]) => k !== "request_id" && k !== "kind");
  if (!cols.length) return;
  await asUser(adminId, (q) =>
    q.query(
      `update public.contests set ${cols.map(([k], i) => `${k} = $${i + 2}${k === "resolution" ? "::jsonb" : ""}`).join(", ")} where id = $1`,
      [id, ...cols.map(([k, v]) => (k === "resolution" ? JSON.stringify(v) : v))],
    ),
  );
  await bump(id);
}

export async function replaceOutcomes(adminId: string, id: string, outcomes: unknown[]) {
  await asUser(adminId, async (q) => {
    await q.query("delete from public.contest_outcomes where contest_id = $1", [id]);
    await insertOutcomes(q, id, outcomes);
  });
  await bump(id);
}

export async function savePool(adminId: string, id: string, pool: unknown[], removeMissing: boolean) {
  await asUser(adminId, async (q) => {
    await upsertPool(q, id, pool);
    if (removeMissing) {
      const names = z.array(PoolInput).parse(pool).map((p) => p.name);
      await q.query(
        "delete from public.pool_items where contest_id = $1 and not (name = any($2)) and id not in (select pool_item_id from public.draft_picks where contest_id = $1)",
        [id, names],
      );
    }
  });
  await bump(id);
}

async function bump(id: string) {
  await asService((q) => q.query("select sidebet_private.bump($1)", [id]));
  notifyContest(id);
}

export async function setStatus(adminId: string, id: string, status: string) {
  await asUser(adminId, (q) => q.query("select public.admin_set_status($1, $2)", [id, status]));
  notifyContest(id);
}

export async function startDraft(adminId: string, id: string, order: string[] | null) {
  await asUser(adminId, (q) => q.query("select public.start_draft($1, $2::uuid[])", [id, order]));
  notifyContest(id);
}

/** Offline import: rosters as names per entry. Unknown names are added to the pool. */
export async function importDraft(adminId: string, id: string, rosters: { entry_id: string; picks: string[] }[]) {
  const n = await asUser(adminId, async (q) => {
    const [c] = await q.query("select roster_size from public.contests where id = $1", [id]);
    if (!c) throw new AppError("contest_not_found");
    const pool = await q.query<{ id: string; name: string }>("select id, name from public.pool_items where contest_id = $1", [id]);
    const findOrCreate = async (name: string) => {
      const hit = pool.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (hit) return hit.id;
      const [row] = await q.query<{ id: string }>("insert into public.pool_items (contest_id, name) values ($1, $2) returning id", [id, name.trim()]);
      pool.push({ id: row.id, name: name.trim() });
      return row.id;
    };
    // interleave rosters into draft order (round by round) so pick numbers read naturally
    const resolved: { entry_id: string; ids: string[] }[] = [];
    for (const r of rosters) resolved.push({ entry_id: r.entry_id, ids: await Promise.all(r.picks.filter((p) => p.trim()).map(findOrCreate)) });
    const seen = new Set<string>();
    for (const r of resolved) for (const pid of r.ids) {
      if (seen.has(pid)) throw new AppError("already_drafted", `${pool.find((p) => p.id === pid)?.name} is on two rosters.`);
      seen.add(pid);
    }
    const ordered: { entry_id: string; pool_item_id: string }[] = [];
    const maxLen = Math.max(...resolved.map((r) => r.ids.length));
    for (let i = 0; i < maxLen; i++) for (const r of resolved) if (r.ids[i]) ordered.push({ entry_id: r.entry_id, pool_item_id: r.ids[i] });
    const [res] = await q.query<{ n: number }>("select public.import_draft($1, $2::jsonb) as n", [id, JSON.stringify(ordered)]);
    return res.n;
  });
  notifyContest(id);
  return n;
}

// ------------------------------------------------------------------ invites --
export async function createInvite(adminId: string, contestId: string, label: string) {
  return asUser(adminId, async (q) => {
    const [r] = await q.query<{ token: string }>("insert into public.invites (contest_id, label, created_by) values ($1, $2, auth.uid()) returning token", [contestId, label || "Invite link"]);
    return r.token;
  });
}
export async function revokeInvite(adminId: string, inviteId: string) {
  await asUser(adminId, (q) => q.query("update public.invites set revoked_at = now() where id = $1 and revoked_at is null", [inviteId]));
}

// ------------------------------------------------------------------- rules --
export async function proposeRuleset(adminId: string, contestId: string, instructions: string) {
  if (instructions.trim().length < 5) throw new AppError("validation", "Describe how you score it.");
  const ctx = await aiContextFor(contestId);
  const ai = await proposeRules(instructions, ctx);
  if (!ai.result.ok) {
    return { ok: false as const, provider: ai.provider, errors: ai.result.errors, raw: ai.raw };
  }
  const p = ai.result.proposal;
  const id = await asUser(adminId, async (q) => {
    const [{ v }] = await q.query<{ v: number }>("select coalesce(max(version), 0) + 1 as v from public.scoring_rulesets where contest_id = $1", [contestId]);
    const [r] = await q.query<{ id: string }>(
      `insert into public.scoring_rulesets (contest_id, version, instructions, rules, questions, unsupported, proposed_by, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, auth.uid()) returning id`,
      [contestId, num(v), instructions, JSON.stringify(p.ruleset), JSON.stringify(p.questions), JSON.stringify(p.unsupported), ai.provider],
    );
    return r.id;
  });
  return { ok: true as const, provider: ai.provider, ruleset_id: id };
}

export async function saveRulesetDraft(adminId: string, rulesetId: string, rulesJson: unknown, answers: Record<string, string>) {
  const parsed = RulesetSchema.safeParse(rulesJson);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  await asUser(adminId, (q) =>
    q.query("update public.scoring_rulesets set rules = $2::jsonb, answers = $3::jsonb where id = $1 and status = 'draft'", [
      rulesetId, JSON.stringify(parsed.data), JSON.stringify(answers ?? {}),
    ]),
  );
}

export async function previewRuleset(adminId: string, contestId: string, rulesJson: unknown) {
  const parsed = RulesetSchema.safeParse(rulesJson);
  if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const pool = await asUser(adminId, (q) => q.query<{ id: string; name: string; seed: number | null }>("select id, name, seed from public.pool_items where contest_id = $1", [contestId]));
  return { ok: true as const, examples: ruleExamples(parsed.data, pool) };
}

export async function approveRuleset(adminId: string, rulesetId: string) {
  const [rs] = await asUser(adminId, (q) => q.query("select * from public.scoring_rulesets where id = $1", [rulesetId]));
  if (!rs) throw new AppError("ruleset_not_found");
  RulesetSchema.parse(rs.rules); // app validates before the DB records approval
  const answers = (rs.answers ?? {}) as Record<string, string>;
  const unanswered = (rs.questions as { id: string }[]).filter((qq) => !answers[qq.id]?.trim());
  if (unanswered.length) throw new AppError("rules_unresolved", `Answer: ${unanswered.map((u) => u.id).join(", ")}`);
  const unsupported = rs.unsupported as unknown[];
  if (unsupported.length && answers.__unsupported_ack !== "yes") {
    throw new AppError("rules_unresolved", "Acknowledge that flagged rules will be handled with explicit admin adjustments.");
  }
  await asService((q) => q.query("select sidebet_private.approve_ruleset($1, $2)", [rulesetId, adminId]));
  notifyContest(rs.contest_id);
}

// ----------------------------------------------------------------- sources --
export const SourceInput = z.object({
  kind: z.enum(["fixture", "sidebet_json", "pgn", "espn", "html", "manual"]),
  url: z.string().url().max(2000).nullable().default(null),
  label: z.string().trim().min(1).max(80).default("Results source"),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

export async function addSource(adminId: string, contestId: string, raw: unknown) {
  const s = SourceInput.parse(raw);
  if (s.kind === "fixture" && !fixtureNames().includes(String(s.config.fixture))) throw new AppError("validation", "Unknown fixture.");
  if (["sidebet_json", "pgn", "espn", "html"].includes(s.kind)) {
    if (!s.url) throw new AppError("validation", "This source needs a URL.");
    await assertPublicUrl(s.url);
  }
  return asUser(adminId, async (q) => {
    const [r] = await q.query<{ id: string }>("insert into public.result_sources (contest_id, kind, url, label, config) values ($1,$2,$3,$4,$5::jsonb) returning id", [
      contestId, s.kind, s.url, s.label, JSON.stringify(s.config),
    ]);
    return r.id;
  });
}

export async function updateSource(adminId: string, sourceId: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) {
  await asUser(adminId, async (q) => {
    if (patch.enabled !== undefined) await q.query("update public.result_sources set enabled = $2 where id = $1", [sourceId, patch.enabled]);
    if (patch.config) await q.query("update public.result_sources set config = config || $2::jsonb where id = $1", [sourceId, JSON.stringify(patch.config)]);
  });
}

export async function deleteSource(adminId: string, sourceId: string) {
  await asUser(adminId, (q) => q.query("delete from public.result_sources where id = $1", [sourceId]));
}

/** Read a source and dry-run it: what the app can read and what scoring would do. */
export async function previewSource(adminId: string, sourceId: string) {
  const [s] = await asUser(adminId, (q) => q.query<SourceRow>("select id, contest_id, kind, url, label, config from public.result_sources where id = $1", [sourceId]));
  if (!s) throw new AppError("validation", "Source not found.");
  const read = await readSource(s, await aiContextFor(s.contest_id));
  let plan = null;
  try {
    plan = await processFacts(s.contest_id, read.events, { source_id: s.id, source_url: read.source_url, origin: read.origin }, { dryRun: true });
  } catch (e) {
    plan = { error: e instanceof Error ? e.message : String(e) };
  }
  return { read, plan };
}

export async function advanceFixture(adminId: string, sourceId: string, delta: number) {
  await asUser(adminId, (q) =>
    q.query(
      "update public.result_sources set config = jsonb_set(config, '{stage}', to_jsonb(greatest(0, coalesce((config->>'stage')::int, 0) + $2))) where id = $1 and kind = 'fixture'",
      [sourceId, delta],
    ),
  );
}

export async function checkNow(contestId: string) {
  return checkContest(contestId, "manual");
}

// ------------------------------------------------------- manual results --
export async function manualPreview(adminId: string, contestId: string, input: { text?: string; facts?: unknown[] }) {
  let events: EventFacts[] = [];
  let notes = "";
  let provider = "Structured entry";
  let rejected: { event_key: string; errors: string[] }[] = [];
  if (input.facts?.length) {
    for (const f of input.facts) {
      const p = EventFactsSchema.safeParse(f);
      if (p.success) events.push(p.data);
      else rejected.push({ event_key: String((f as { event_key?: string }).event_key ?? "?"), errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
  } else if (input.text?.trim()) {
    const r = await parseManualResult(input.text.trim().slice(0, 4000), await aiContextFor(contestId));
    events = r.events;
    notes = r.notes;
    provider = r.provider;
    rejected = r.rejected;
  } else throw new AppError("validation", "Enter a result.");
  const plan = events.length ? await processFacts(contestId, events, { origin: "manual", approved_by: adminId }, { dryRun: true }) : null;
  return { provider, notes, events, rejected, plan };
}

export async function manualApply(adminId: string, contestId: string, facts: unknown[]) {
  const events = z.array(EventFactsSchema).min(1).max(50).parse(facts);
  return processFacts(contestId, events, { origin: "manual", approved_by: adminId, source_url: null });
}

// ------------------------------------------------------------------ review --
export async function resolveReview(
  adminId: string,
  reviewId: string,
  action: "map" | "choose" | "dismiss" | "acknowledge",
  payload: { mapping?: Record<string, string>; choice?: number; note?: string } = {},
) {
  const [r] = await asUser(adminId, (q) => q.query("select * from public.review_items where id = $1", [reviewId]));
  if (!r) throw new AppError("validation", "Review item not found.");
  if (r.status !== "open") return { already: true };
  const note = payload.note?.slice(0, 400) ?? null;
  const close = (q: Q, resolution: string) =>
    q.query("update public.review_items set status = $2, resolution = $3, resolved_by = $4, resolved_at = now() where id = $1", [
      reviewId, resolution === "dismissed" ? "dismissed" : "resolved", note ? `${resolution}: ${note}` : resolution, adminId,
    ]);

  if (action === "map") {
    // Teach the contest the alias, then re-run the same facts through the pipeline.
    const mapping = z.record(z.string(), z.string().uuid()).parse(payload.mapping ?? {});
    await asUser(adminId, async (q) => {
      for (const [name, poolId] of Object.entries(mapping)) {
        await q.query("update public.pool_items set aliases = array_append(aliases, $2) where id = $1 and not ($2 = any(aliases)) and name <> $2", [poolId, name]);
      }
      await close(q, "mapped");
    });
    await asService((q) => q.query("update public.event_revisions set state = 'superseded' where id = $1", [r.revision_id]));
    const facts = EventFactsSchema.parse(r.detail.facts);
    return processFacts(r.contest_id, [facts], { ...(r.detail.meta ?? { origin: "manual" }), approved_by: adminId });
  }
  if (action === "choose") {
    const cands = z.array(EventFactsSchema).parse(r.detail.candidates ?? []);
    const chosen = cands[payload.choice ?? -1];
    if (!chosen) throw new AppError("validation", "Pick one of the results.");
    await asUser(adminId, (q) => close(q, `chose result ${(payload.choice ?? 0) + 1}`));
    return processFacts(r.contest_id, [chosen], { ...(r.detail.meta ?? { origin: "manual" }), approved_by: adminId, force: true });
  }
  await asUser(adminId, (q) => close(q, action === "acknowledge" ? "acknowledged" : "dismissed"));
  if (r.revision_id) await asService((q) => q.query("update public.event_revisions set state = 'rejected' where id = $1 and state = 'pending_review'", [r.revision_id]));
  await asService(async (q) => {
    const [{ n }] = await q.query("select count(*)::int as n from public.review_items where contest_id = $1 and status = 'open'", [r.contest_id]);
    if (num(n) === 0) await q.query("update public.contests set result_status = case when kind = 'bet' and proposed_outcome_id is not null then 'final' else 'provisional' end where id = $1 and status <> 'settled'", [r.contest_id]);
    await q.query("select sidebet_private.bump($1)", [r.contest_id]);
  });
  notifyContest(r.contest_id);
  return { ok: true };
}

export async function addAdjustment(adminId: string, contestId: string, input: { pool_item_id?: string | null; entry_id?: string | null; points: number; reason: string }) {
  const a = z
    .object({ pool_item_id: z.string().uuid().nullable().optional(), entry_id: z.string().uuid().nullable().optional(), points: z.number().min(-1000).max(1000), reason: z.string().trim().min(3).max(400) })
    .parse(input);
  await asUser(adminId, async (q) => {
    await q.query("insert into public.adjustments (contest_id, pool_item_id, entry_id, points, reason, approved_by) values ($1,$2,$3,$4,$5, auth.uid())", [
      contestId, a.pool_item_id ?? null, a.entry_id ?? null, a.points, a.reason,
    ]);
  });
  await asService(async (q) => {
    await q.query("insert into public.score_changes (contest_id, kind, summary) values ($1, 'adjustment', $2)", [contestId, `Admin adjustment ${a.points >= 0 ? "+" : ""}${a.points}: ${a.reason}`]);
    await q.query("select sidebet_private.bump($1)", [contestId]);
  });
  notifyContest(contestId);
}

// -------------------------------------------------------------- settlement --
export async function settlementPreview(adminId: string, contestId: string, outcomeOverride?: string | null) {
  return asUser(adminId, async (q) => {
    const [{ is_admin }] = await q.query("select public.is_admin() as is_admin");
    if (!is_admin) throw new AppError("admin_only");
    const [c] = await q.query("select * from public.contests where id = $1", [contestId]);
    if (!c) throw new AppError("contest_not_found");
    const entries = await q.query(
      `select e.id, e.user_id, e.stake, e.joined_at, e.seat, p.username, p.display_name, b.outcome_id
         from public.entries e join public.profiles p on p.id = e.user_id left join public.bet_picks b on b.entry_id = e.id
        where e.contest_id = $1 order by e.seat`,
      [contestId],
    );
    const [{ n: openReviews }] = await q.query("select count(*)::int as n from public.review_items where contest_id = $1 and status = 'open'", [contestId]);
    let outcomeId: string | null = null;
    let result;
    let standings: ReturnType<typeof computeStandings> = [];
    if (c.kind === "bet") {
      outcomeId = outcomeOverride ?? c.proposed_outcome_id ?? null;
      if (!outcomeId) throw new AppError("validation", "No outcome yet — wait for a final result or choose the outcome.");
      const [o] = await q.query("select id from public.contest_outcomes where id = $1 and contest_id = $2", [outcomeId, contestId]);
      if (!o) throw new AppError("validation", "Unknown outcome.");
      result = betPayout(entries as PayoutEntry[], outcomeId);
    } else {
      const picks = await q.query("select entry_id, pool_item_id, pick_no from public.draft_picks where contest_id = $1", [contestId]);
      const lines = await q.query(
        `select s.pool_item_id, s.points from public.score_lines s join public.events ev on ev.id = s.event_id and ev.current_revision_id = s.revision_id where s.contest_id = $1`,
        [contestId],
      );
      const adjs = await q.query("select pool_item_id, entry_id, points from public.adjustments where contest_id = $1", [contestId]);
      standings = computeStandings({
        entries: entries.map((e) => ({ id: e.id, user_id: e.user_id, seat: e.seat, joined_at: e.joined_at })),
        picks: picks as { entry_id: string; pool_item_id: string; pick_no: number }[],
        lines: lines.map((l) => ({ pool_item_id: l.pool_item_id, points: num(l.points) })),
        adjustments: adjs.map((a) => ({ pool_item_id: a.pool_item_id, entry_id: a.entry_id, points: num(a.points) })),
        tiebreakers: c.tiebreakers,
      });
      result = draftPayout(entries.map((e) => {
        const s = standings.find((x) => x.entry_id === e.id)!;
        return { ...e, place: s.place, points: s.total } as PayoutEntry;
      }));
    }
    const hash = previewHash(outcomeId, result);
    return {
      contest_id: contestId,
      kind: c.kind,
      status: c.status,
      outcome_id: outcomeId,
      open_reviews: num(openReviews),
      pot: result.pot,
      summary: result.summary,
      hash,
      lines: result.lines.map((l) => {
        const e = entries.find((x) => x.id === l.entry_id)!;
        return { ...l, username: e.username, display_name: e.display_name, stake: e.stake };
      }),
    };
  });
}

export async function settleContest(adminId: string, contestId: string, outcomeId: string | null, hash: string) {
  const preview = await settlementPreview(adminId, contestId, outcomeId);
  if (preview.status === "settled") return { result: "already_settled" };
  if (preview.hash !== hash) throw new AppError("preview_changed");
  if (preview.open_reviews > 0) throw new AppError("validation", "Resolve open review items before settling.");
  const [r] = await asService((q) =>
    q.query<{ r: string }>("select sidebet_private.settle_contest($1, $2, $3, $4::jsonb, $5::jsonb, $6) as r", [
      contestId, adminId, preview.outcome_id,
      JSON.stringify(preview.lines.map((l) => ({ entry_id: l.entry_id, status: l.status, place: l.place, payout: l.payout, refund: l.refund, points: l.points }))),
      JSON.stringify({ text: preview.summary, pot: preview.pot }),
      hash,
    ]),
  );
  notifyContest(contestId);
  return { result: r.r };
}

export async function cancelContest(adminId: string, contestId: string, reason: string) {
  const [r] = await asService((q) => q.query<{ r: string }>("select sidebet_private.cancel_contest($1, $2, $3) as r", [contestId, adminId, reason.slice(0, 400) || "Canceled by admin"]));
  notifyContest(contestId);
  return { result: r.r };
}

// --------------------------------------------------------------- requests --
export async function updateRequest(adminId: string, id: string, status: "reviewing" | "declined" | "submitted", note: string | null) {
  await asUser(adminId, (q) => q.query("update public.contest_requests set status = $2, admin_note = $3, updated_at = now() where id = $1", [id, status, note]));
}

// ------------------------------------------------------------ admin view --
export async function getAdminContest(adminId: string, contestId: string) {
  return asUser(adminId, async (q) => {
    const [{ is_admin }] = await q.query("select public.is_admin() as is_admin");
    if (!is_admin) throw new AppError("admin_only");
    const invites = await q.query("select id, token, label, uses, revoked_at, created_at from public.invites where contest_id = $1 order by created_at desc", [contestId]);
    const sources = await q.query("select * from public.result_sources where contest_id = $1 order by created_at", [contestId]);
    const rulesets = await q.query("select * from public.scoring_rulesets where contest_id = $1 order by version desc", [contestId]);
    const reviews = await q.query("select * from public.review_items where contest_id = $1 order by status = 'open' desc, created_at desc limit 50", [contestId]);
    const revisions = await q.query(
      `select r.id, r.revision, r.state, r.origin, r.source_url, r.evidence, r.review_reason, r.created_at, r.facts, ev.event_key, ev.label
         from public.event_revisions r join public.events ev on ev.id = r.event_id where r.contest_id = $1 order by r.created_at desc limit 80`,
      [contestId],
    );
    return { invites, sources, rulesets, reviews, revisions, fixtures: fixtureNames(), demo: config.mode === "demo" };
  });
}

export async function adminOverview(adminId: string) {
  return asUser(adminId, async (q) => {
    const [{ is_admin }] = await q.query("select public.is_admin() as is_admin");
    if (!is_admin) throw new AppError("admin_only");
    const contests = await q.query(
      `select c.id, c.title, c.kind, c.status, c.visibility, c.result_status, c.last_success_at, c.last_error,
              (select count(*)::int from public.review_items r where r.contest_id = c.id and r.status = 'open') as open_reviews,
              (select count(*)::int from public.entries e where e.contest_id = c.id) as entrants
         from public.contests c order by c.created_at desc limit 200`,
    );
    const requests = await q.query(
      "select r.*, p.username, p.display_name from public.contest_requests r join public.profiles p on p.id = r.user_id order by r.status = 'submitted' desc, r.created_at desc limit 100",
    );
    return { contests, requests };
  });
}

// --------------------------------------------------------- demo helpers --
export async function demoAdvanceClock(adminId: string, seconds: number) {
  if (config.mode !== "demo") throw new AppError("forbidden", "Clock controls exist only in demo mode.");
  await asUser(adminId, async (q) => {
    const [{ is_admin }] = await q.query("select public.is_admin() as is_admin");
    if (!is_admin) throw new AppError("admin_only");
  });
  await asService((q) => q.query("update public.app_settings set clock_offset_seconds = clock_offset_seconds + $1 where id = 1", [Math.trunc(seconds)]));
}

export type { Ruleset };
