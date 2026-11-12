import { asService, asUser, num, type Q } from "./db";
import { AppError, isAppError } from "./errors";
import { notifyContest } from "./live";
import { computeStandings, type LiveContext } from "../scoring/engine";
import type { Ruleset } from "../scoring/schema";

export type ContestStatus =
  | "setup"
  | "open"
  | "drafting"
  | "locked"
  | "active"
  | "awaiting_settlement"
  | "settled"
  | "canceled";

export type ContestRow = {
  id: string;
  kind: "bet" | "draft";
  title: string;
  description: string;
  category: "chess" | "sports" | "custom";
  visibility: "public" | "private";
  status: ContestStatus;
  stake: number;
  max_entrants: number | null;
  lock_at: string | null;
  pick_visibility: "after_lock" | "always";
  payout_rule: "equal_split_winners" | "winner_take_all";
  tiebreakers: string[];
  terms_text: string;
  terms_locked_at: string | null;
  roster_size: number | null;
  draft_format: "snake" | "straight" | null;
  draft_mode: "live" | "offline" | null;
  draft_order: string[] | null;
  resolution: { event_key?: string; label?: string };
  live_context: LiveContext | null;
  proposed_outcome_id: string | null;
  result_outcome_id: string | null;
  result_status: "none" | "provisional" | "final" | "review";
  last_check_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  settled_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
};

export const TIE_TEXT: Record<string, string> = {
  bet: "Winning entries split the pot equally. Leftover chips from an uneven split go one each to the earliest winning entries. If nobody picked the winning outcome, every stake is refunded.",
  draft:
    "Highest roster total wins the pot. Tiebreaker: best single pick. Entrants still tied split the pot equally; leftover chips go one each to the earliest entries.",
};
export const CANCEL_TEXT = "If the contest is canceled, every stake is refunded in full. Canceled contests don't count toward records.";

export function payoutText(c: Pick<ContestRow, "kind" | "payout_rule">) {
  return c.kind === "bet" || c.payout_rule === "equal_split_winners"
    ? "Equal split among winning entries"
    : "Winner takes all";
}

async function refresh(q: Q, id: string) {
  const [r] = await q.query<{ s: string }>("select public.refresh_contest($1) as s", [id]);
  return r?.s;
}

export async function listContests(userId: string, scope: "public" | "mine" | "all") {
  return asUser(userId, async (q) => {
    const where =
      scope === "public"
        ? "c.visibility = 'public' and c.status <> 'setup'"
        : scope === "mine"
          ? "exists (select 1 from public.entries e where e.contest_id = c.id and e.user_id = auth.uid()) or exists (select 1 from public.contest_access a where a.contest_id = c.id and a.user_id = auth.uid())"
          : "true";
    return q.query<ContestRow & { entrants: number; pot: number; joined: boolean }>(
      `select c.*,
              (select count(*)::int from public.entries e where e.contest_id = c.id) as entrants,
              (select coalesce(sum(stake),0)::int from public.entries e where e.contest_id = c.id) as pot,
              exists (select 1 from public.entries e where e.contest_id = c.id and e.user_id = auth.uid()) as joined
         from public.contests c
        where ${where}
        order by case c.status when 'active' then 0 when 'drafting' then 1 when 'open' then 2 when 'locked' then 3
                 when 'awaiting_settlement' then 4 when 'setup' then 5 when 'settled' then 6 else 7 end, c.created_at desc
        limit 100`,
    );
  });
}

export type ScoreLineView = {
  id: string;
  rule_id: string;
  label: string;
  points: number;
  detail: string;
  source_url: string | null;
  event_id: string;
  event_label: string;
  event_status: string;
  kind: "rule" | "adjustment";
};

export async function getContestView(userId: string, contestId: string) {
  return asUser(userId, async (q) => {
    await refresh(q, contestId);
    const [c] = await q.query<ContestRow>("select * from public.contests where id = $1", [contestId]);
    if (!c) throw new AppError("contest_not_found");
    const [{ is_admin }] = await q.query<{ is_admin: boolean }>("select public.is_admin() as is_admin");
    const [{ picks_visible }] = await q.query<{ picks_visible: boolean }>("select public.picks_visible($1) as picks_visible", [contestId]);
    const [{ now }] = await q.query<{ now: Date }>("select public.app_now() as now");

    const entrants = await q.query<{
      entry_id: string; user_id: string; username: string; display_name: string; seat: number; status: string;
      payout: number; refund: number; place: number | null; stake: number; joined_at: string; final_points: number | null;
    }>(
      `select e.id as entry_id, e.user_id, p.username, p.display_name, e.seat, e.status, e.payout, e.refund, e.place,
              e.stake, e.joined_at, e.final_points
         from public.entries e join public.profiles p on p.id = e.user_id
        where e.contest_id = $1 order by e.seat`,
      [contestId],
    );
    const mine = entrants.find((e) => e.user_id === userId) ?? null;
    const pot = entrants.reduce((s, e) => s + e.stake, 0);

    const outcomes = await q.query<{ id: string; label: string; color: string; sort_order: number; resolve_when: unknown[] }>(
      "select id, label, color, sort_order, resolve_when from public.contest_outcomes where contest_id = $1 order by sort_order, label",
      [contestId],
    );
    // RLS decides which picks come back: yours always, others' only once revealed.
    const picks = await q.query<{ entry_id: string; user_id: string; outcome_id: string }>(
      "select entry_id, user_id, outcome_id from public.bet_picks where contest_id = $1",
      [contestId],
    );
    const showAll = picks_visible || is_admin;
    const outcomeViews = outcomes.map((o) => {
      const backers = picks
        .filter((p) => p.outcome_id === o.id && (showAll || p.user_id === userId))
        .map((p) => entrants.find((e) => e.entry_id === p.entry_id))
        .filter(Boolean)
        .map((e) => ({ user_id: e!.user_id, username: e!.username, display_name: e!.display_name }));
      return { ...o, backers: showAll ? backers : backers.filter((b) => b.user_id === userId), count: showAll ? backers.length : null };
    });
    const myPick = picks.find((p) => p.user_id === userId)?.outcome_id ?? null;

    // ----- draft data -----
    let draft = null as null | {
      pool: { id: string; name: string; kind: string; seed: number | null; aliases: string[]; drafted_by: string | null; pick_no: number | null }[];
      picks: { pick_no: number; round: number; entry_id: string; pool_item_id: string; source: string }[];
      on_clock: string | null;
      total_picks: number;
      next_pick_no: number;
    };
    let rosters: {
      entry_id: string; user_id: string; username: string; display_name: string; total: number; place: number;
      tied: boolean; best_pick: number;
      picks: { pool_item_id: string; name: string; seed: number | null; points: number; pick_no: number; lines: ScoreLineView[] }[];
      entry_adjustments: ScoreLineView[];
    }[] = [];

    if (c.kind === "draft") {
      const pool = await q.query<{ id: string; name: string; kind: string; seed: number | null; aliases: string[] }>(
        "select id, name, kind, seed, aliases from public.pool_items where contest_id = $1 order by seed nulls last, name",
        [contestId],
      );
      const dpicks = await q.query<{ pick_no: number; round: number; entry_id: string; pool_item_id: string; source: string }>(
        "select pick_no, round, entry_id, pool_item_id, source from public.draft_picks where contest_id = $1 order by pick_no",
        [contestId],
      );
      const [{ on_clock }] = await q.query<{ on_clock: string | null }>("select public.draft_on_clock($1) as on_clock", [contestId]);
      draft = {
        pool: pool.map((p) => {
          const dp = dpicks.find((d) => d.pool_item_id === p.id);
          return { ...p, drafted_by: dp?.entry_id ?? null, pick_no: dp?.pick_no ?? null };
        }),
        picks: dpicks,
        on_clock: c.status === "drafting" ? on_clock : null,
        total_picks: entrants.length * (c.roster_size ?? 0),
        next_pick_no: dpicks.length + 1,
      };

      const lines = await q.query<{
        id: string; pool_item_id: string; rule_id: string; label: string; points: number; detail: string;
        source_url: string | null; event_id: string; event_label: string; event_status: string;
      }>(
        `select s.id, s.pool_item_id, s.rule_id, s.label, s.points, s.detail, s.source_url, s.event_id,
                coalesce(nullif(ev.label,''), ev.event_key) as event_label, ev.status as event_status
           from public.score_lines s join public.events ev on ev.id = s.event_id
           join public.event_revisions r on r.id = s.revision_id and r.state = 'applied' and ev.current_revision_id = r.id
          where s.contest_id = $1 order by s.created_at`,
        [contestId],
      );
      const adjs = await q.query<{ id: string; pool_item_id: string | null; entry_id: string | null; points: number; reason: string }>(
        "select id, pool_item_id, entry_id, points, reason from public.adjustments where contest_id = $1 order by created_at",
        [contestId],
      );
      const standings = computeStandings({
        entries: entrants.map((e) => ({ id: e.entry_id, user_id: e.user_id, seat: e.seat, joined_at: e.joined_at })),
        picks: dpicks,
        lines: lines.map((l) => ({ pool_item_id: l.pool_item_id, points: num(l.points) })),
        adjustments: adjs.map((a) => ({ ...a, points: num(a.points) })),
        tiebreakers: c.tiebreakers,
      });
      const adjView = (a: (typeof adjs)[number]): ScoreLineView => ({
        id: a.id, rule_id: "adjustment", label: "Admin adjustment", points: num(a.points), detail: a.reason,
        source_url: null, event_id: "", event_label: "Manual adjustment", event_status: "final", kind: "adjustment",
      });
      rosters = standings.map((s) => {
        const e = entrants.find((x) => x.entry_id === s.entry_id)!;
        return {
          entry_id: s.entry_id, user_id: e.user_id, username: e.username, display_name: e.display_name,
          total: s.total, place: s.place, tied: s.tied, best_pick: s.best_pick,
          picks: dpicks
            .filter((d) => d.entry_id === s.entry_id)
            .map((d) => {
              const item = pool.find((p) => p.id === d.pool_item_id)!;
              return {
                pool_item_id: d.pool_item_id, name: item.name, seed: item.seed, pick_no: d.pick_no,
                points: s.pick_totals[d.pool_item_id] ?? 0,
                lines: [
                  ...lines.filter((l) => l.pool_item_id === d.pool_item_id).map((l) => ({ ...l, points: num(l.points), kind: "rule" as const })),
                  ...adjs.filter((a) => a.pool_item_id === d.pool_item_id).map(adjView),
                ],
              };
            }),
          entry_adjustments: adjs.filter((a) => a.entry_id === s.entry_id && !a.pool_item_id).map(adjView),
        };
      });
    }

    const events = await q.query<{ id: string; event_key: string; label: string; status: string; updated_at: string; facts: unknown; revision: number; source_url: string | null; origin: string }>(
      `select ev.id, ev.event_key, ev.label, ev.status, ev.updated_at, r.facts, r.revision, r.source_url, r.origin
         from public.events ev left join public.event_revisions r on r.id = ev.current_revision_id
        where ev.contest_id = $1 order by ev.updated_at desc limit 60`,
      [contestId],
    );
    const changes = await q.query<{ id: number; kind: string; summary: string; deltas: unknown; created_at: string }>(
      "select id, kind, summary, deltas, created_at from public.score_changes where contest_id = $1 order by id desc limit 20",
      [contestId],
    );
    const [ruleset] = await q.query<{ id: string; instructions: string; rules: Ruleset; unsupported: unknown[]; answers: Record<string, string>; approved_at: string; version: number }>(
      "select id, instructions, rules, unsupported, answers, approved_at, version from public.scoring_rulesets where contest_id = $1 and status = 'approved'",
      [contestId],
    );
    const [settlement] = await q.query<{ lines: unknown; summary: unknown; created_at: string }>(
      "select lines, summary, created_at from public.settlements where contest_id = $1",
      [contestId],
    );
    const openReviews = is_admin
      ? (await q.query<{ n: number }>("select count(*)::int as n from public.review_items where contest_id = $1 and status = 'open'", [contestId]))[0].n
      : 0;

    const lockPassed = c.lock_at ? new Date(c.lock_at).getTime() <= new Date(now).getTime() : false;
    let joinBlock: string | null = null;
    if (mine) joinBlock = "joined";
    else if (c.status !== "open" || lockPassed) joinBlock = "closed";
    else if (c.max_entrants && entrants.length >= c.max_entrants) joinBlock = "full";

    return {
      contest: c,
      server_now: new Date(now).toISOString(),
      viewer: { id: userId, is_admin, entry_id: mine?.entry_id ?? null, join_block: joinBlock },
      terms: { payout: payoutText(c), tie: TIE_TEXT[c.kind], cancel: CANCEL_TEXT },
      pot,
      entrants,
      outcomes: outcomeViews,
      my_pick: myPick,
      picks_visible: picks_visible,
      draft,
      rosters,
      events: events.map((e) => ({ ...e, revision: num(e.revision) })),
      changes,
      ruleset: ruleset ?? null,
      settlement: settlement ?? null,
      open_reviews: openReviews,
    };
  });
}
export type ContestView = Awaited<ReturnType<typeof getContestView>>;

/** Like getContestView, but null when the contest doesn't exist or the user can't see it. */
export async function findContestView(userId: string, contestId: string): Promise<ContestView | null> {
  if (!/^[0-9a-f-]{36}$/.test(contestId)) return null;
  try {
    return await getContestView(userId, contestId);
  } catch (e) {
    if (isAppError(e) && e.code === "contest_not_found") return null;
    throw e;
  }
}

export async function joinContest(userId: string, contestId: string, outcomeId: string | null) {
  const entryId = await asUser(userId, async (q) => {
    await refresh(q, contestId);
    const [r] = await q.query<{ id: string }>("select public.join_contest($1, $2) as id", [contestId, outcomeId]);
    return r.id;
  });
  notifyContest(contestId);
  return entryId;
}

export async function redeemInvite(userId: string, token: string) {
  const cid = await asUser(userId, async (q) => {
    const [r] = await q.query<{ id: string }>("select public.redeem_invite($1) as id", [token]);
    return r.id;
  });
  notifyContest(cid);
  return cid;
}

/** Invite preview for the join screen (doesn't grant access). */
export async function inviteInfo(token: string) {
  const rows = await asService((q) =>
    q.query<{ contest_id: string; title: string; kind: string; stake: number; status: string; revoked_at: string | null; lock_at: string | null }>(
      `select c.id as contest_id, c.title, c.kind, c.stake, c.status, i.revoked_at, c.lock_at
         from public.invites i join public.contests c on c.id = i.contest_id where i.token = $1`,
      [token],
    ),
  );
  return rows[0] ?? null;
}

export async function makeDraftPick(userId: string, contestId: string, poolItemId: string, expectedPickNo?: number) {
  const n = await asUser(userId, async (q) => {
    const [r] = await q.query<{ n: number }>("select public.make_draft_pick($1, $2, $3) as n", [contestId, poolItemId, expectedPickNo ?? null]);
    return r.n;
  });
  notifyContest(contestId);
  return n;
}
