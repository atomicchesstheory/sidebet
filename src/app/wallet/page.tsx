import Link from "next/link";
import { redirect } from "next/navigation";
import { Chips } from "@/components/brand";
import { ClaimCard } from "@/components/claim-card";
import { Empty } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { getSessionUser } from "@/lib/server/auth";
import { getWallet } from "@/lib/server/wallet";

export const metadata = { title: "Wallet" };

const KIND: Record<string, string> = { starting_grant: "Starting chips", free_claim: "Free claim", stake: "Stake", payout: "Payout", refund: "Refund" };

export default async function Wallet() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/wallet");
  const w = await getWallet(user.id);
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-4xl font-extrabold uppercase">Wallet</h1>
      <ClaimCard canClaim={w.can_claim} nextAt={w.next_claim_at} serverNow={w.server_now} amount={w.claim_amount} balance={w.balance} staked={w.staked} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="card p-4"><div className="chip-label text-cream-faint">Available</div><div className="font-display text-3xl font-bold"><Chips n={w.balance} /></div></div>
        <div className="card p-4"><div className="chip-label text-cream-faint">Staked now</div><div className="font-display text-3xl font-bold"><Chips n={w.staked} /></div></div>
        <div className="card col-span-2 p-4 text-sm text-cream-dim md:col-span-1">
          New accounts start with <span className="num text-cream">{w.starting_chips}</span>. Claim <span className="num text-cream">{w.claim_amount}</span> free chips every 23 hours. Chips are free and can&apos;t be redeemed.
        </div>
      </div>
      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3 font-display text-xl font-bold uppercase">Transactions</div>
        {w.history.length === 0 ? (
          <div className="p-4"><Empty title="No transactions yet" /></div>
        ) : (
          <ul className="divide-y divide-line">
            {w.history.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{KIND[h.kind] ?? h.kind}</div>
                  <div className="truncate text-xs text-cream-dim">
                    {h.contest_id ? <Link className="link" href={`/c/${h.contest_id}`}>{h.memo}</Link> : h.memo} · {fmtTime(h.created_at)}
                  </div>
                </div>
                <div className={`num font-bold ${h.amount > 0 ? "text-lime" : "text-cream-dim"}`}>{h.amount > 0 ? "+" : ""}{h.amount}</div>
                <div className="num w-16 text-right text-xs text-cream-faint" title="Balance after">{h.balance_after}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
