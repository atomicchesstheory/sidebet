import { z } from "zod";
import * as admin from "./admin";
import { getSessionUser, type SessionUser } from "./auth";
import { joinContest, makeDraftPick, redeemInvite } from "./contests";
import { AppError } from "./errors";
import { submitRequest, updateDisplayName } from "./profiles";
import { claimChips } from "./wallet";

/**
 * Every mutation goes through this table. `admin: true` is checked here on
 * the server AND again by the database (RLS policies / is_admin() checks).
 */
type Action = { admin?: boolean; input: z.ZodType; run: (u: SessionUser, input: never) => Promise<unknown> };

const id = z.string().uuid();
const A = <S extends z.ZodType>(input: S, run: (u: SessionUser, i: z.infer<S>) => Promise<unknown>, isAdmin = false): Action => ({
  admin: isAdmin,
  input,
  run: run as Action["run"],
});

export const actions: Record<string, Action> = {
  // ------------------------------------------------------------- users --
  claim: A(z.object({}), (u) => claimChips(u.id)),
  join: A(z.object({ contest_id: id, outcome_id: id.nullable().default(null) }), (u, i) => joinContest(u.id, i.contest_id, i.outcome_id).then((entry_id) => ({ entry_id }))),
  redeem_invite: A(z.object({ token: z.string().min(10).max(100) }), (u, i) => redeemInvite(u.id, i.token).then((contest_id) => ({ contest_id }))),
  draft_pick: A(z.object({ contest_id: id, pool_item_id: id, expected_pick_no: z.number().int().positive().optional() }), (u, i) =>
    makeDraftPick(u.id, i.contest_id, i.pool_item_id, i.expected_pick_no).then((pick_no) => ({ pick_no })),
  ),
  update_display_name: A(z.object({ display_name: z.string().trim().min(1).max(40) }), (u, i) => updateDisplayName(u.id, i.display_name)),
  submit_request: A(z.object({ title: z.string().trim().min(3).max(120), body: z.string().trim().min(3).max(4000) }), (u, i) =>
    submitRequest(u.id, i.title, i.body).then((rid) => ({ id: rid })),
  ),

  // ------------------------------------------------------------- admin --
  create_contest: A(z.object({ contest: z.unknown(), outcomes: z.array(z.unknown()).default([]), pool: z.array(z.unknown()).default([]) }), (u, i) =>
    admin.createContest(u.id, i.contest, i.outcomes, i.pool).then((cid) => ({ id: cid })), true),
  update_contest: A(z.object({ contest_id: id, patch: z.unknown() }), (u, i) => admin.updateContest(u.id, i.contest_id, i.patch), true),
  replace_outcomes: A(z.object({ contest_id: id, outcomes: z.array(z.unknown()) }), (u, i) => admin.replaceOutcomes(u.id, i.contest_id, i.outcomes), true),
  save_pool: A(z.object({ contest_id: id, pool: z.array(z.unknown()), remove_missing: z.boolean().default(false) }), (u, i) =>
    admin.savePool(u.id, i.contest_id, i.pool, i.remove_missing), true),
  set_status: A(z.object({ contest_id: id, status: z.enum(["setup", "open", "locked", "active", "awaiting_settlement"]) }), (u, i) =>
    admin.setStatus(u.id, i.contest_id, i.status), true),
  start_draft: A(z.object({ contest_id: id, order: z.array(id).nullable().default(null) }), (u, i) => admin.startDraft(u.id, i.contest_id, i.order), true),
  import_draft: A(z.object({ contest_id: id, rosters: z.array(z.object({ entry_id: id, picks: z.array(z.string().max(80)).max(30) })).min(2) }), (u, i) =>
    admin.importDraft(u.id, i.contest_id, i.rosters).then((n) => ({ picks: n })), true),
  create_invite: A(z.object({ contest_id: id, label: z.string().max(60).default("") }), (u, i) => admin.createInvite(u.id, i.contest_id, i.label).then((token) => ({ token })), true),
  revoke_invite: A(z.object({ invite_id: id }), (u, i) => admin.revokeInvite(u.id, i.invite_id), true),
  propose_rules: A(z.object({ contest_id: id, instructions: z.string().min(5).max(4000) }), (u, i) => admin.proposeRuleset(u.id, i.contest_id, i.instructions), true),
  save_rules: A(z.object({ ruleset_id: id, rules: z.unknown(), answers: z.record(z.string(), z.string()).default({}) }), (u, i) =>
    admin.saveRulesetDraft(u.id, i.ruleset_id, i.rules, i.answers), true),
  preview_rules: A(z.object({ contest_id: id, rules: z.unknown() }), (u, i) => admin.previewRuleset(u.id, i.contest_id, i.rules), true),
  approve_rules: A(z.object({ ruleset_id: id }), (u, i) => admin.approveRuleset(u.id, i.ruleset_id), true),
  add_source: A(z.object({ contest_id: id, source: z.unknown() }), (u, i) => admin.addSource(u.id, i.contest_id, i.source).then((sid) => ({ id: sid })), true),
  update_source: A(z.object({ source_id: id, enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), (u, i) =>
    admin.updateSource(u.id, i.source_id, i), true),
  delete_source: A(z.object({ source_id: id }), (u, i) => admin.deleteSource(u.id, i.source_id), true),
  preview_source: A(z.object({ source_id: id }), (u, i) => admin.previewSource(u.id, i.source_id), true),
  advance_fixture: A(z.object({ source_id: id, delta: z.number().int().min(-10).max(10) }), (u, i) => admin.advanceFixture(u.id, i.source_id, i.delta), true),
  check_now: A(z.object({ contest_id: id }), (_u, i) => admin.checkNow(i.contest_id), true),
  manual_preview: A(z.object({ contest_id: id, text: z.string().max(4000).optional(), facts: z.array(z.unknown()).max(50).optional() }), (u, i) =>
    admin.manualPreview(u.id, i.contest_id, i), true),
  manual_apply: A(z.object({ contest_id: id, facts: z.array(z.unknown()).min(1).max(50) }), (u, i) => admin.manualApply(u.id, i.contest_id, i.facts), true),
  resolve_review: A(
    z.object({ review_id: id, action: z.enum(["map", "choose", "dismiss", "acknowledge"]), mapping: z.record(z.string(), z.string()).optional(), choice: z.number().int().optional(), note: z.string().max(400).optional() }),
    (u, i) => admin.resolveReview(u.id, i.review_id, i.action, i), true),
  add_adjustment: A(z.object({ contest_id: id, pool_item_id: id.nullable().optional(), entry_id: id.nullable().optional(), points: z.number(), reason: z.string() }), (u, i) =>
    admin.addAdjustment(u.id, i.contest_id, i), true),
  settlement_preview: A(z.object({ contest_id: id, outcome_id: id.nullable().optional() }), (u, i) => admin.settlementPreview(u.id, i.contest_id, i.outcome_id ?? null), true),
  settle: A(z.object({ contest_id: id, outcome_id: id.nullable(), hash: z.string().max(100) }), (u, i) => admin.settleContest(u.id, i.contest_id, i.outcome_id, i.hash), true),
  cancel: A(z.object({ contest_id: id, reason: z.string().max(400).default("") }), (u, i) => admin.cancelContest(u.id, i.contest_id, i.reason), true),
  update_request: A(z.object({ request_id: id, status: z.enum(["submitted", "reviewing", "declined"]), note: z.string().max(1000).nullable().default(null) }), (u, i) =>
    admin.updateRequest(u.id, i.request_id, i.status, i.note), true),
  demo_clock: A(z.object({ seconds: z.number().int().min(-86400 * 30).max(86400 * 30) }), (u, i) => admin.demoAdvanceClock(u.id, i.seconds), true),
};

export async function runAction(name: string, body: unknown) {
  const a = actions[name];
  if (!a) throw new AppError("validation", "Unknown action.");
  const user = await getSessionUser();
  if (!user) throw new AppError("not_signed_in");
  if (a.admin && !user.is_admin) throw new AppError("admin_only");
  const parsed = a.input.safeParse(body ?? {});
  if (!parsed.success) throw new AppError("validation", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return a.run(user, parsed.data as never);
}
