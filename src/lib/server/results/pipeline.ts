import crypto from "node:crypto";
import { asService, num, type Q } from "../db";
import { AppError } from "../errors";
import { notifyContest } from "../live";
import { liveContext, normalizeFacts, resolveOutcome, scoreEvent, type ScoreLineDraft } from "../../scoring/engine";
import { matchName, type PoolEntity } from "../../scoring/match";
import { EventFactsSchema, ResolveWhenSchema, RulesetSchema, type EventFacts, type Ruleset } from "../../scoring/schema";
import { readSource, type SourceRow } from "./adapters";

export type Origin = "feed" | "ai" | "manual" | "fixture";
export type PipelineMeta = { source_id?: string | null; source_url?: string | null; origin: Origin; approved_by?: string | null; force?: boolean };

export type PlanItem = {
  event_key: string;
  label: string;
  action: "new" | "update" | "correction" | "unchanged" | "review" | "skipped";
  reason?: string;
  status: EventFacts["status"];
  lines: (ScoreLineDraft & { pick_name: string })[];
  deltas: { pool_item_id: string; name: string; entry_id: string | null; before: number; after: number }[];
  matched: { name: string; pool_item_id: string | null; status: string }[];
  outcome?: { outcome_id: string | null; label: string | null };
};

export type PipelineResult = {
  items: PlanItem[];
  counts: Record<PlanItem["action"], number>;
  dry_run: boolean;
};

class DryRun extends Error {
  constructor(public result: PipelineResult) {
    super("dry_run");
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Stable identity of a result's content; the same facts always hash the same. */
export function fingerprint(f: EventFacts): string {
  const { evidence: _e, ...rest } = normalizeFacts(f);
  void _e;
  return crypto.createHash("sha256").update(canonical(rest)).digest("hex").slice(0, 32);
}

function missingFacts(f: EventFacts): string | null {
  if (f.status !== "final") return null;
  const hasResult = f.participants.some((p) => p.result != null || p.place != null);
  if ((f.event_type === "match" || f.event_type === "game") && f.participants.length === 2 && !f.winner) {
    const bothDraw = f.participants.every((p) => p.result === "draw");
    if (!bothDraw) return "Final result has no winner and isn't marked as a draw.";
  }
  if (!hasResult && !f.winner) return "Final result doesn't say who won or where anyone placed.";
  return null;
}

async function openReview(q: Q, contestId: string, eventId: string | null, revisionId: string | null, kind: string, title: string, detail: unknown) {
  await q.query(
    "insert into public.review_items (contest_id, event_id, revision_id, kind, title, detail) values ($1, $2, $3, $4, $5, $6::jsonb)",
    [contestId, eventId, revisionId, kind, title, JSON.stringify(detail)],
  );
}

/**
 * The one scoring pipeline: scheduled checks, "Check results now", admin
 * results and review resolutions all go through here.
 */
export async function processFacts(contestId: string, input: EventFacts[], meta: PipelineMeta, opts: { dryRun?: boolean } = {}): Promise<PipelineResult> {
  const events = input.map((e) => EventFactsSchema.parse(e)); // never trust callers
  try {
    const result = await asService(async (q) => {
      const [c] = await q.query("select * from public.contests where id = $1 for update", [contestId]);
      if (!c) throw new AppError("contest_not_found");
      const tracking = c.kind === "draft" ? ["active", "awaiting_settlement", "settled"] : ["open", "locked", "active", "awaiting_settlement", "settled"];
      if (!tracking.includes(c.status)) throw new AppError("validation", `This contest isn't tracking results yet (status: ${c.status}).`);
      const settled = c.status === "settled";

      let ruleset: Ruleset | null = null;
      if (c.kind === "draft") {
        const [rs] = await q.query("select rules from public.scoring_rulesets where contest_id = $1 and status = 'approved'", [contestId]);
        if (!rs) throw new AppError("needs_approved_rules");
        ruleset = RulesetSchema.parse(rs.rules);
      }
      const pool = (await q.query("select id, name, aliases, seed from public.pool_items where contest_id = $1", [contestId])) as (PoolEntity & { seed: number | null })[];
      const picks = await q.query<{ pool_item_id: string; entry_id: string }>("select pool_item_id, entry_id from public.draft_picks where contest_id = $1", [contestId]);
      const outcomes = (await q.query("select id, label, resolve_when from public.contest_outcomes where contest_id = $1", [contestId])).map((o) => ({
        id: o.id as string,
        label: o.label as string,
        resolve_when: ResolveWhenSchema.parse(o.resolve_when ?? []),
      }));

      const items: PlanItem[] = [];
      const byKey = new Map<string, EventFacts[]>();
      for (const e of events) byKey.set(e.event_key, [...(byKey.get(e.event_key) ?? []), e]);

      for (const [key, group] of byKey) {
        const fps = new Set(group.map(fingerprint));
        const base = normalizeFacts(group[0]);
        const item: PlanItem = { event_key: key, label: base.label ?? key, action: "unchanged", status: base.status, lines: [], deltas: [], matched: [] };
        items.push(item);

        let [ev] = await q.query("select * from public.events where contest_id = $1 and event_key = $2", [contestId, key]);
        const current = ev?.current_revision_id
          ? (await q.query("select * from public.event_revisions where id = $1", [ev.current_revision_id]))[0]
          : null;

        if (fps.size > 1 && !meta.force) {
          // Same match reported two different ways in one check: don't guess.
          const fp = [...fps].sort().join("|");
          const seen = await q.query("select 1 from public.review_items where contest_id = $1 and kind = 'conflict' and detail->>'fp' = $2 and status <> 'resolved'", [contestId, fp]);
          item.action = "review";
          item.reason = "Conflicting results for the same event";
          if (!seen.length) {
            await openReview(q, contestId, ev?.id ?? null, null, "conflict", `Conflicting results for ${base.label ?? key}`, { fp, candidates: group, meta });
          }
          continue;
        }

        const facts = base;
        const fp = fingerprint(facts);
        if (current && current.fingerprint === fp) {
          item.action = "unchanged";
          continue;
        }
        if (ev) {
          const pending = await q.query("select 1 from public.event_revisions where event_id = $1 and fingerprint = $2 and state in ('pending_review','rejected')", [ev.id, fp]);
          if (pending.length) {
            item.action = "unchanged";
            item.reason = "Already waiting for (or dismissed in) admin review";
            continue;
          }
        }

        // Bets only care about the event that decides them.
        if (c.kind === "bet" && c.resolution?.event_key && c.resolution.event_key !== key) {
          item.action = "skipped";
          item.reason = "Not the event this bet tracks";
          continue;
        }

        // ---- match participants to picks ----
        const matchedMap = new Map<number, string>();
        const ambiguous: { name: string; candidates: { id: string; name: string }[] }[] = [];
        const scoredFacts: EventFacts = { ...facts, participants: facts.participants.map((p) => ({ ...p })) };
        if (c.kind === "draft") {
          scoredFacts.participants.forEach((p, i) => {
            const m = matchName(p.name, pool);
            if (m.status === "matched") {
              matchedMap.set(i, m.id);
              const seed = pool.find((x) => x.id === m.id)?.seed;
              if (seed) p.seed = seed; // contest seeds are authoritative
              item.matched.push({ name: p.name, pool_item_id: m.id, status: "matched" });
            } else if (m.status === "ambiguous") {
              ambiguous.push({ name: p.name, candidates: m.candidates });
              item.matched.push({ name: p.name, pool_item_id: null, status: "ambiguous" });
            } else {
              item.matched.push({ name: p.name, pool_item_id: null, status: "not in contest" });
            }
          });
        }

        let reviewKind: string | null = null;
        let reviewTitle = "";
        let reviewDetail: Record<string, unknown> = {};
        const missing = missingFacts(facts);
        if (ambiguous.length) {
          reviewKind = "ambiguous_name";
          reviewTitle = `Who is ${ambiguous.map((a) => `“${a.name}”`).join(", ")}?`;
          reviewDetail = { ambiguous };
        } else if (missing) {
          reviewKind = "missing_fact";
          reviewTitle = `${facts.label ?? key}: ${missing}`;
        } else if (settled) {
          reviewKind = "correction_after_payout";
          reviewTitle = `${facts.label ?? key} changed after chips were paid`;
          reviewDetail = { previous: current?.facts ?? null };
        }

        let outcomeId: string | null = null;
        if (c.kind === "bet" && !reviewKind) {
          const r = resolveOutcome(outcomes, facts);
          outcomeId = r.outcome_id;
          if (facts.status === "final" && !r.outcome_id) {
            reviewKind = r.ambiguous ? "conflict" : "missing_fact";
            reviewTitle = r.ambiguous ? "Final result matches more than one outcome" : "Final result doesn't match any outcome";
          }
          item.outcome = { outcome_id: outcomeId, label: outcomes.find((o) => o.id === outcomeId)?.label ?? null };
        }

        const prevRevNo = ev ? num((await q.query("select coalesce(max(revision),0) as n from public.event_revisions where event_id = $1", [ev.id]))[0].n) : 0;
        if (!ev) {
          [ev] = await q.query(
            "insert into public.events (contest_id, event_key, label, status) values ($1, $2, $3, $4) returning *",
            [contestId, key, facts.label ?? key, reviewKind ? "review" : facts.status === "final" ? "final" : "provisional"],
          );
        }

        if (reviewKind) {
          const [rev] = await q.query(
            `insert into public.event_revisions (event_id, contest_id, revision, facts, fingerprint, source_id, source_url, evidence, origin, state, review_reason)
             values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'pending_review', $10) returning id`,
            [ev.id, contestId, prevRevNo + 1, JSON.stringify(facts), fp, meta.source_id ?? null, meta.source_url ?? null, facts.evidence ?? null, meta.origin, reviewTitle],
          );
          await openReview(q, contestId, ev.id, rev.id, reviewKind, reviewTitle, { ...reviewDetail, facts, meta });
          if (reviewKind === "correction_after_payout") {
            await q.query("insert into public.score_changes (contest_id, event_id, kind, summary) values ($1, $2, 'review', $3)", [
              contestId, ev.id, `${facts.label ?? key} was corrected after settlement — flagged for admin review. Chips unchanged.`,
            ]);
          }
          item.action = "review";
          item.reason = reviewTitle;
          continue;
        }

        // ---- apply: application code scores verified facts ----
        const drafts = c.kind === "draft" && ruleset ? scoreEvent(ruleset, scoredFacts, matchedMap) : [];
        const oldLines = ev.current_revision_id
          ? await q.query<{ pool_item_id: string; points: number }>("select pool_item_id, points from public.score_lines where event_id = $1", [ev.id])
          : [];
        const touched = new Set([...drafts.map((d) => d.pool_item_id), ...oldLines.map((l) => l.pool_item_id)]);
        for (const pid of touched) {
          const before = oldLines.filter((l) => l.pool_item_id === pid).reduce((s, l) => s + num(l.points), 0);
          const after = drafts.filter((l) => l.pool_item_id === pid).reduce((s, l) => s + l.points, 0);
          if (before !== after) item.deltas.push({ pool_item_id: pid, name: pool.find((p) => p.id === pid)?.name ?? "?", entry_id: picks.find((p) => p.pool_item_id === pid)?.entry_id ?? null, before, after });
        }
        item.lines = drafts.map((d) => ({ ...d, pick_name: pool.find((p) => p.id === d.pool_item_id)?.name ?? "?" }));
        const wasFinal = current?.facts?.status === "final";
        item.action = !current ? "new" : wasFinal ? "correction" : "update";

        const [rev] = await q.query(
          `insert into public.event_revisions (event_id, contest_id, revision, facts, fingerprint, source_id, source_url, evidence, origin, state, approved_by)
           values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'applied', $10) returning id`,
          [ev.id, contestId, prevRevNo + 1, JSON.stringify(facts), fp, meta.source_id ?? null, meta.source_url ?? null, facts.evidence ?? null, meta.origin, meta.approved_by ?? null],
        );
        await q.query("update public.event_revisions set state = 'superseded' where event_id = $1 and id <> $2 and state = 'applied'", [ev.id, rev.id]);
        await q.query("delete from public.score_lines where event_id = $1", [ev.id]);
        for (const d of drafts) {
          await q.query(
            `insert into public.score_lines (contest_id, event_id, revision_id, pool_item_id, rule_id, label, points, detail, source_url)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [contestId, ev.id, rev.id, d.pool_item_id, d.rule_id, d.label, d.points, d.detail, meta.source_url ?? null],
          );
        }
        await q.query("update public.events set current_revision_id = $2, status = $3, label = $4, updated_at = now() where id = $1", [
          ev.id, rev.id, facts.status === "final" ? "final" : "provisional", facts.label ?? key,
        ]);
        const deltaText = item.deltas.map((d) => `${d.name} ${d.after - d.before >= 0 ? "+" : ""}${Math.round((d.after - d.before) * 100) / 100}`).join(", ");
        const summary =
          item.action === "correction"
            ? `Correction: ${facts.label ?? key}${deltaText ? ` — ${deltaText}` : " — no point change"}`
            : `${facts.label ?? key} (${facts.status.replace("_", " ")})${deltaText ? `: ${deltaText}` : ""}`;
        // Log what moved scores (or a final/corrected result); skip schedule/progress noise.
        if (item.deltas.length > 0 || item.action === "correction" || facts.status === "final") {
          await q.query("insert into public.score_changes (contest_id, event_id, kind, summary, deltas) values ($1, $2, $3, $4, $5::jsonb)", [
            contestId, ev.id, item.action, summary, JSON.stringify(item.deltas),
          ]);
        }

        if (c.kind === "bet") {
          const live = liveContext(facts);
          let status = c.status as string;
          if (status === "locked" && facts.status !== "scheduled") status = "active";
          if (facts.status === "final" && outcomeId && ["locked", "active"].includes(status)) status = "awaiting_settlement";
          if (status === "awaiting_settlement" && (facts.status !== "final" || !outcomeId)) status = "active";
          await q.query(
            "update public.contests set live_context = $2::jsonb, proposed_outcome_id = $3, result_status = $4, status = $5 where id = $1",
            [contestId, JSON.stringify(live), outcomeId, facts.status === "final" && outcomeId ? "final" : "provisional", status],
          );
          c.status = status;
        }
      }

      const [{ n: open }] = await q.query("select count(*)::int as n from public.review_items where contest_id = $1 and status = 'open'", [contestId]);
      if (c.kind === "draft") {
        await q.query("update public.contests set result_status = $2 where id = $1 and status <> 'settled'", [contestId, num(open) > 0 ? "review" : "provisional"]);
      } else if (num(open) > 0) {
        await q.query("update public.contests set result_status = 'review' where id = $1 and status <> 'settled'", [contestId]);
      }
      await q.query("select sidebet_private.bump($1)", [contestId]);

      const counts = { new: 0, update: 0, correction: 0, unchanged: 0, review: 0, skipped: 0 } as PipelineResult["counts"];
      for (const i of items) counts[i.action]++;
      const res: PipelineResult = { items, counts, dry_run: !!opts.dryRun };
      if (opts.dryRun) throw new DryRun(res); // roll back: preview == what apply would do
      return res;
    });
    notifyContest(contestId);
    return result;
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}

// --------------------------------------------------------------- checks --

export async function aiContextFor(contestId: string): Promise<string> {
  return asService(async (q) => {
    const [c] = await q.query("select title, kind, category, description, resolution from public.contests where id = $1", [contestId]);
    const pool = await q.query("select name, seed, aliases from public.pool_items where contest_id = $1 order by seed nulls last, name limit 200", [contestId]);
    const outcomes = await q.query("select label from public.contest_outcomes where contest_id = $1", [contestId]);
    return [
      `Contest: ${c?.title} (${c?.kind}, ${c?.category})`,
      c?.description ? `Description: ${c.description}` : "",
      pool.length ? `Tracked picks: ${pool.map((p) => `${p.name}${p.seed ? ` [seed ${p.seed}]` : ""}${p.aliases?.length ? ` (aka ${p.aliases.join(", ")})` : ""}`).join("; ")}` : "",
      outcomes.length ? `Bet outcomes: ${outcomes.map((o) => o.label).join(" | ")}` : "",
      c?.resolution?.label ? `Tracked event: ${c.resolution.label}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
}

export type SourceCheck = { source_id: string; label: string; ok: boolean; error?: string; notes?: string; counts?: PipelineResult["counts"]; rejected?: number };

export async function checkContest(contestId: string, trigger: "manual" | "schedule"): Promise<SourceCheck[]> {
  const sources = await asService((q) =>
    q.query<SourceRow>("select id, contest_id, kind, url, label, config from public.result_sources where contest_id = $1 and enabled and kind <> 'manual' order by created_at", [contestId]),
  );
  const out: SourceCheck[] = [];
  const ctx = sources.some((s) => s.kind === "html") ? await aiContextFor(contestId) : "";
  for (const s of sources) {
    await asService((q) => q.query("update public.result_sources set last_attempt_at = now() where id = $1", [s.id]));
    try {
      const read = await readSource(s, ctx);
      const res = await processFacts(contestId, read.events, { source_id: s.id, source_url: read.source_url, origin: read.origin });
      await asService(async (q) => {
        await q.query("update public.result_sources set last_success_at = now(), last_error = null, last_preview = $2::jsonb where id = $1", [
          s.id, JSON.stringify({ notes: read.notes, events: read.events.length, rejected: read.rejected, trigger }),
        ]);
        if (read.rejected.length) {
          const fp = `rejected:${s.id}:${read.rejected.map((r) => r.event_key).join(",")}`;
          const seen = await q.query("select 1 from public.review_items where contest_id = $1 and detail->>'fp' = $2", [contestId, fp]);
          if (!seen.length) {
            await openReview(q, contestId, null, null, "extraction", `${read.rejected.length} result(s) from ${s.label} failed validation`, { fp, rejected: read.rejected });
          }
        }
      });
      out.push({ source_id: s.id, label: s.label, ok: true, notes: read.notes, counts: res.counts, rejected: read.rejected.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Keep last verified scores: a failed source only records the error.
      await asService((q) => q.query("update public.result_sources set last_error = $2 where id = $1", [s.id, msg.slice(0, 500)]));
      out.push({ source_id: s.id, label: s.label, ok: false, error: msg });
    }
  }
  const anyOk = out.some((o) => o.ok);
  const errors = out.filter((o) => !o.ok).map((o) => `${o.label}: ${o.error}`).join("; ");
  await asService((q) =>
    q.query(
      `update public.contests set last_check_at = now(), last_success_at = case when $2 then now() else last_success_at end,
              last_error = nullif($3, '') where id = $1`,
      [contestId, anyOk, errors],
    ),
  );
  notifyContest(contestId);
  return out;
}

export async function runScheduledChecks() {
  const contests = await asService((q) =>
    q.query<{ id: string; title: string }>(
      `select distinct c.id, c.title from public.contests c join public.result_sources s on s.contest_id = c.id and s.enabled and s.kind <> 'manual'
        where c.status in ('locked','active','awaiting_settlement') or (c.kind = 'bet' and c.status = 'open')`,
    ),
  );
  const results: { contest_id: string; title: string; sources: SourceCheck[] }[] = [];
  for (const c of contests) {
    try {
      results.push({ contest_id: c.id, title: c.title, sources: await checkContest(c.id, "schedule") });
    } catch (e) {
      results.push({ contest_id: c.id, title: c.title, sources: [{ source_id: "", label: "check", ok: false, error: String(e) }] });
    }
  }
  return results;
}
