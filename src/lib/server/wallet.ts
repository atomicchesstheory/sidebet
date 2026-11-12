import { asUser, num } from "./db";

export async function getWallet(userId: string) {
  return asUser(userId, async (q) => {
    const [w] = await q.query<{ balance: number; last_claim_at: Date | null }>(
      "select balance, last_claim_at from public.wallets where user_id = auth.uid()",
    );
    const [s] = await q.query<{ claim_amount: number; claim_cooldown_seconds: number; starting_chips: number }>(
      "select claim_amount, claim_cooldown_seconds, starting_chips from public.app_settings where id = 1",
    );
    const [{ now }] = await q.query<{ now: Date }>("select public.app_now() as now");
    const [{ staked }] = await q.query<{ staked: number }>(
      `select coalesce(sum(e.stake), 0)::int as staked from public.entries e join public.contests c on c.id = e.contest_id
        where e.user_id = auth.uid() and c.status not in ('settled','canceled')`,
    );
    const history = await q.query<{
      id: number; kind: string; amount: number; balance_after: number; memo: string | null; created_at: Date; contest_id: string | null;
    }>(
      "select id, kind, amount, balance_after, memo, created_at, contest_id from public.ledger where user_id = auth.uid() order by id desc limit 100",
    );
    const next = w?.last_claim_at ? new Date(new Date(w.last_claim_at).getTime() + s.claim_cooldown_seconds * 1000) : null;
    const nowD = new Date(now);
    return {
      balance: w?.balance ?? 0,
      staked: num(staked),
      claim_amount: s.claim_amount,
      cooldown_seconds: s.claim_cooldown_seconds,
      starting_chips: s.starting_chips,
      server_now: nowD.toISOString(),
      next_claim_at: next && next > nowD ? next.toISOString() : null,
      can_claim: !next || next <= nowD,
      history: history.map((h) => ({ ...h, id: num(h.id), created_at: new Date(h.created_at).toISOString() })),
    };
  });
}
export type WalletView = Awaited<ReturnType<typeof getWallet>>;

export async function claimChips(userId: string) {
  return asUser(userId, async (q) => {
    const [r] = await q.query<{ r: { amount: number; balance: number; next_claim_at: string } }>("select public.claim_chips() as r");
    return r.r;
  });
}
