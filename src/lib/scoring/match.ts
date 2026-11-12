import { normName } from "./engine";

export type PoolEntity = { id: string; name: string; aliases: string[]; seed?: number | null };

export type MatchResult =
  | { status: "matched"; id: string }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
  | { status: "none" };

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Match a name from a results source to the contest's picks.
 * Exact (normalized name or alias) => matched. Close-but-not-exact => ambiguous
 * (goes to admin review, never auto-scored). Otherwise none.
 */
export function matchName(name: string, pool: PoolEntity[]): MatchResult {
  const n = normName(name);
  if (!n) return { status: "none" };
  const exact = pool.filter((p) => [p.name, ...p.aliases].some((x) => normName(x) === n));
  if (exact.length === 1) return { status: "matched", id: exact[0].id };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((p) => ({ id: p.id, name: p.name })) };

  const toks = n.split(" ");
  const last = toks[toks.length - 1];
  const fuzzy = pool.filter((p) =>
    [p.name, ...p.aliases].some((x) => {
      const m = normName(x);
      const mt = m.split(" ");
      const sameLast = mt[mt.length - 1] === last && last.length >= 3;
      const initialOk = toks.length === 1 || mt.length === 1 || mt[0][0] === toks[0][0];
      const close = m.length >= 5 && lev(m, n) <= 2;
      return (sameLast && initialOk) || close;
    }),
  );
  if (fuzzy.length > 0) return { status: "ambiguous", candidates: fuzzy.map((p) => ({ id: p.id, name: p.name })) };
  return { status: "none" };
}
