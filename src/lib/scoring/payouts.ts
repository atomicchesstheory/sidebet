/**
 * Deterministic payouts. Whole chips only.
 *
 * Published leftover rule: when a pot doesn't divide evenly, every winner gets
 * floor(pot / winners) and the remaining chips go one each to winners in the
 * order they joined (earliest first; entry id breaks exact ties).
 */

export type PayoutEntry = {
  id: string;
  user_id: string;
  stake: number;
  joined_at: string | Date;
  outcome_id?: string | null;
  place?: number | null;
  points?: number | null;
};

export type PayoutLine = {
  entry_id: string;
  user_id: string;
  status: "won" | "lost" | "tied" | "push" | "refunded";
  place: number | null;
  payout: number;
  refund: number;
  points: number | null;
};

export type PayoutResult = {
  pot: number;
  lines: PayoutLine[];
  summary: string;
  kind: "winners_split" | "refund_all";
};

const byJoin = (a: PayoutEntry, b: PayoutEntry) =>
  new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function splitPot(pot: number, winners: PayoutEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  if (winners.length === 0) return out;
  const ordered = [...winners].sort(byJoin);
  const base = Math.floor(pot / ordered.length);
  let left = pot - base * ordered.length;
  for (const w of ordered) {
    out.set(w.id, base + (left > 0 ? 1 : 0));
    if (left > 0) left--;
  }
  return out;
}

export function refundAll(entries: PayoutEntry[], summary: string): PayoutResult {
  const pot = entries.reduce((s, e) => s + e.stake, 0);
  return {
    pot,
    kind: "refund_all",
    summary,
    lines: entries.map((e) => ({
      entry_id: e.id,
      user_id: e.user_id,
      status: "push",
      place: null,
      payout: 0,
      refund: e.stake,
      points: e.points ?? null,
    })),
  };
}

/** Normal bet: equal split among entries that picked the winning outcome; nobody right => refunds. */
export function betPayout(entries: PayoutEntry[], winningOutcome: string): PayoutResult {
  const pot = entries.reduce((s, e) => s + e.stake, 0);
  const winners = entries.filter((e) => e.outcome_id === winningOutcome);
  if (winners.length === 0) return refundAll(entries, "Nobody picked the winning side — every stake is refunded.");
  const shares = splitPot(pot, winners);
  return {
    pot,
    kind: "winners_split",
    summary:
      winners.length === 1
        ? `One winning entry takes the ${pot}-chip pot.`
        : `${winners.length} winning entries split the ${pot}-chip pot.`,
    lines: entries.map((e) => ({
      entry_id: e.id,
      user_id: e.user_id,
      status: shares.has(e.id) ? "won" : "lost",
      place: shares.has(e.id) ? 1 : 2,
      payout: shares.get(e.id) ?? 0,
      refund: 0,
      points: null,
    })),
  };
}

/** Draft: winner takes all; entrants still tied after the published tiebreakers split equally. */
export function draftPayout(entries: PayoutEntry[]): PayoutResult {
  const pot = entries.reduce((s, e) => s + e.stake, 0);
  const winners = entries.filter((e) => e.place === 1);
  if (winners.length === 0) return refundAll(entries, "No placements — every stake is refunded.");
  const shares = splitPot(pot, winners);
  const tied = winners.length > 1;
  return {
    pot,
    kind: "winners_split",
    summary: tied
      ? `${winners.length} entrants tied for first after tiebreakers and split the ${pot}-chip pot.`
      : `Winner takes the ${pot}-chip pot.`,
    lines: entries.map((e) => ({
      entry_id: e.id,
      user_id: e.user_id,
      status: shares.has(e.id) ? (tied ? "tied" : "won") : "lost",
      place: e.place ?? null,
      payout: shares.get(e.id) ?? 0,
      refund: 0,
      points: e.points ?? null,
    })),
  };
}

/** Stable hash of a settlement preview, so confirm must match what the admin saw. */
export function previewHash(outcome: string | null, r: PayoutResult): string {
  const canon = JSON.stringify({
    outcome,
    lines: [...r.lines]
      .sort((a, b) => (a.entry_id < b.entry_id ? -1 : 1))
      .map((l) => [l.entry_id, l.status, l.place, l.payout, l.refund, l.points]),
  });
  let h = 2166136261;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + canon.length;
}
