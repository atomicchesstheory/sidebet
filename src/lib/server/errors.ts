export const ERROR_MESSAGES: Record<string, [number, string]> = {
  not_signed_in: [401, "Sign in first."],
  admin_only: [403, "Admins only."],
  forbidden: [403, "You don't have access to that."],
  contest_not_found: [404, "Contest not found."],
  insufficient_chips: [409, "Not enough chips for that stake."],
  claim_not_ready: [409, "Your next free chips aren't ready yet."],
  wallet_missing: [500, "Wallet missing."],
  entries_closed: [409, "Entries are closed."],
  contest_full: [409, "This contest is full."],
  pick_a_side: [400, "Pick a side first."],
  terms_locked: [409, "Terms are locked — someone has already entered."],
  contest_closed: [409, "This contest is already closed."],
  use_settlement_flow: [409, "Use the settlement flow for that."],
  use_rule_approval: [409, "Rules can only be approved through the approval flow."],
  bad_transition: [409, "That status change isn't allowed right now."],
  needs_two_outcomes: [400, "Add at least two outcomes first."],
  needs_approved_rules: [400, "Approve scoring rules before opening entries."],
  needs_two_entrants: [400, "Need at least two entrants."],
  bad_draft_order: [400, "Draft order must list every entrant once."],
  not_a_draft: [400, "Not a draft contest."],
  draft_not_live: [409, "The draft isn't live."],
  draft_complete: [409, "The draft is complete."],
  not_your_turn: [409, "You're not on the clock."],
  already_drafted: [409, "That pick is already taken."],
  pick_not_available: [400, "That pick isn't in this contest."],
  stale_pick: [409, "The board moved — refresh and pick again."],
  scoring_started: [409, "Results are already scored; rosters are final."],
  roster_too_big: [400, "A roster has more picks than the roster size."],
  bad_entry: [400, "Unknown entrant."],
  pick_already_drafted: [409, "That pick is on a roster and can't be removed."],
  invite_not_found: [404, "That invite link doesn't exist."],
  invite_revoked: [410, "That invite link was revoked."],
  not_ready_to_settle: [409, "The contest isn't awaiting settlement."],
  payout_mismatch: [409, "Payouts don't add up to the pot."],
  preview_changed: [409, "Results changed since your preview — preview again."],
  ruleset_not_found: [404, "Ruleset not found."],
  bad_display_name: [400, "Display name must be 1–40 characters."],
  username_taken: [409, "That username is taken."],
  bad_credentials: [401, "Wrong username or password."],
  validation: [400, "Check the form and try again."],
  source_blocked: [400, "That URL isn't an allowed public source."],
  rules_unresolved: [400, "Resolve every flagged rule before approving."],
  user_not_found: [404, "No player with that username."],
  cant_friend_self: [400, "You can't friend yourself."],
  not_friends: [403, "You can only add people who are on your friends list."],
  achievement_locked: [409, "You haven't unlocked that one yet."],
};

const BRAND = Symbol.for("sidebet.AppError");

export class AppError extends Error {
  code: string;
  status: number;
  detail?: unknown;
  readonly [BRAND] = true;
  constructor(code: string, message?: string, detail?: unknown) {
    const known = ERROR_MESSAGES[code];
    super(message ?? known?.[1] ?? code);
    this.code = code;
    this.status = known?.[0] ?? 400;
    this.detail = detail;
  }
}

/** Brand check instead of instanceof: bundlers can load this module more than once. */
export function isAppError(e: unknown): e is AppError {
  return !!e && typeof e === "object" && (e as Record<symbol, unknown>)[BRAND] === true;
}

/** Turn a Postgres error (raised by our functions/triggers) into an AppError. */
export function mapDbError(e: unknown): unknown {
  if (isAppError(e)) return e;
  const err = e as { message?: string; code?: string; constraint?: string };
  const msg = (err?.message ?? "").trim();
  if (ERROR_MESSAGES[msg]) return new AppError(msg);
  if (err?.code === "23505") {
    if (/draft_picks/.test(msg) || /pool_item/.test(err.constraint ?? "")) return new AppError("already_drafted");
    if (/username/.test(msg) || /profiles_username/.test(err.constraint ?? "")) return new AppError("username_taken");
  }
  if (err?.code === "23514" && /balance/.test(msg)) return new AppError("insufficient_chips");
  // RLS violation / permission denied (e.g. private functions)
  if (err?.code === "42501") return new AppError("forbidden", undefined, msg);
  return e;
}
