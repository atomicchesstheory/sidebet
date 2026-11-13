import { z } from "zod";
import { asService, asUser } from "./db";
import { AppError } from "./errors";
import { getContestView } from "./contests";
import { listFriends } from "./friends";
import { notifyContest } from "./live";

const COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"] as const;

export const ManualContestInput = z
  .object({
    kind: z.enum(["bet", "draft"]),
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).default(""),
    stake: z.number().int().min(0).max(100000),
    sides: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    roster_size: z.number().int().min(1).max(30).nullable().default(null),
    pick_visibility: z.enum(["after_lock", "always"]).default("after_lock"),
    terms_text: z.string().trim().max(2000).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "bet") {
      const uniq = new Set(v.sides.map((s) => s.toLowerCase()));
      if (v.sides.length < 2) ctx.addIssue({ code: "custom", path: ["sides"], message: "Add at least two sides." });
      else if (uniq.size !== v.sides.length) ctx.addIssue({ code: "custom", path: ["sides"], message: "Each side needs a different name." });
    }
    if (v.kind === "draft" && !v.roster_size) ctx.addIssue({ code: "custom", path: ["roster_size"], message: "Pick a roster size." });
  });

/** Any player can start a manual contest. They run it; nothing is auto-tracked. */
export async function createManualContest(userId: string, raw: unknown) {
  const c = ManualContestInput.parse(raw);
  return asUser(userId, async (q) => {
    const [row] = await q.query<{ id: string }>(
      `insert into public.contests (kind, title, description, category, visibility, stake, pick_visibility, payout_rule,
         terms_text, roster_size, draft_format, draft_mode, manual, created_by)
       values ($1, $2, $3, 'custom', 'private', $4, $5, $6, $7, $8, $9, $10, true, auth.uid()) returning id`,
      [
        c.kind, c.title, c.description, c.stake, c.pick_visibility,
        c.kind === "bet" ? "equal_split_winners" : "winner_take_all",
        c.terms_text,
        c.kind === "draft" ? c.roster_size : null,
        c.kind === "draft" ? "straight" : null,
        c.kind === "draft" ? "offline" : null,
      ],
    );
    if (c.kind === "bet") {
      let i = 0;
      for (const label of c.sides) {
        await q.query("insert into public.contest_outcomes (contest_id, label, color, sort_order) values ($1, $2, $3, $4)", [row.id, label, COLORS[i % COLORS.length], i]);
        i++;
      }
    }
    return row.id;
  });
}

export const ScoreInput = z.object({
  pool_item_id: z.string().uuid(),
  points: z.number().min(-100000).max(100000),
  note: z.string().trim().max(200).default(""),
});

/** Set running totals for rostered players/teams. Only changed rows are written. */
export async function setManualScores(userId: string, contestId: string, raw: unknown[]) {
  const scores = z.array(ScoreInput).min(1).max(300).parse(raw);
  const changed = await asUser(userId, async (q) => {
    const [c] = await q.query<{ kind: string; manual: boolean }>("select kind, manual from public.contests where id = $1", [contestId]);
    if (!c) throw new AppError("contest_not_found");
    if (c.kind !== "draft") throw new AppError("not_a_draft");
    const before = await q.query<{ pool_item_id: string; points: number; note: string }>(
      "select pool_item_id, points, note from public.manual_scores where contest_id = $1",
      [contestId],
    );
    const names = await q.query<{ id: string; name: string }>("select id, name from public.pool_items where contest_id = $1", [contestId]);
    const out: { name: string; from: number; to: number }[] = [];
    for (const s of scores) {
      const prev = before.find((b) => b.pool_item_id === s.pool_item_id);
      if (prev && Number(prev.points) === s.points && prev.note === s.note) continue;
      if (!prev && s.points === 0 && !s.note) continue;
      await q.query(
        `insert into public.manual_scores (pool_item_id, contest_id, points, note, updated_by, updated_at)
         values ($1, $2, $3, $4, auth.uid(), now())
         on conflict (pool_item_id) do update set points = excluded.points, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
        [s.pool_item_id, contestId, s.points, s.note],
      );
      out.push({ name: names.find((n) => n.id === s.pool_item_id)?.name ?? "?", from: Number(prev?.points ?? 0), to: s.points });
    }
    return out;
  });
  if (changed.length) {
    const summary =
      changed.length === 1
        ? `${changed[0].name}: ${changed[0].from} → ${changed[0].to}`
        : `Updated ${changed.length} scores (${changed.slice(0, 3).map((x) => `${x.name} ${x.to}`).join(", ")}${changed.length > 3 ? "…" : ""})`;
    await asService(async (q) => {
      await q.query("insert into public.score_changes (contest_id, kind, summary) values ($1, 'update', $2)", [contestId, summary]);
      await q.query("update public.contests set last_success_at = now(), last_check_at = now() where id = $1", [contestId]);
      await q.query("select sidebet_private.bump($1)", [contestId]);
    });
    notifyContest(contestId);
  }
  return { changed: changed.length };
}

/** Everything the organizer's manage page needs. */
export async function getManageView(userId: string, contestId: string) {
  const [view, friends, extra] = await Promise.all([
    getContestView(userId, contestId),
    listFriends(userId),
    asUser(userId, async (q) => {
      const [{ ok }] = await q.query<{ ok: boolean }>("select public.can_manage_contest($1) as ok", [contestId]);
      if (!ok) return null;
      const invites = await q.query<{ id: string; token: string; label: string; uses: number; revoked_at: string | null }>(
        "select id, token, label, uses, revoked_at from public.invites where contest_id = $1 order by created_at desc",
        [contestId],
      );
      const access = await q.query<{ user_id: string }>("select user_id from public.contest_access where contest_id = $1", [contestId]);
      return { invites, access: access.map((a) => a.user_id) };
    }),
  ]);
  if (!extra) throw new AppError("forbidden");
  const inContest = new Set([...extra.access, ...view.entrants.map((e) => e.user_id)]);
  return {
    view,
    invites: extra.invites.map((i) => ({ ...i, revoked_at: i.revoked_at ? new Date(i.revoked_at).toISOString() : null })),
    friends: friends.friends.map((f) => ({ ...f, invited: inContest.has(f.user_id), joined: view.entrants.some((e) => e.user_id === f.user_id) })),
  };
}
export type ManageView = Awaited<ReturnType<typeof getManageView>>;

export const DetailsInput = z.object({
  title: z.string().trim().min(3, "Titles need at least 3 characters.").max(120),
  description: z.string().trim().max(2000).default(""),
});

/** Title and description stay editable by the organizer at any time (they aren't part of the locked terms). */
export async function editContestDetails(userId: string, contestId: string, raw: unknown) {
  const d = DetailsInput.parse(raw);
  const rows = await asUser(userId, (q) =>
    q.query("update public.contests set title = $2, description = $3 where id = $1 returning id", [contestId, d.title, d.description]),
  );
  if (!rows.length) throw new AppError("forbidden");
  await asService((q) => q.query("select sidebet_private.bump($1)", [contestId]));
  notifyContest(contestId);
  return { title: d.title, description: d.description };
}
