import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { ClaimCard } from "@/components/claim-card";
import { ContestCard } from "@/components/contest/contest-card";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { listContests } from "@/lib/server/contests";
import { getWallet } from "@/lib/server/wallet";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <section className="grid gap-10 py-10 md:grid-cols-2 md:items-center">
        <div className="grid gap-5">
          <Wordmark size="lg" />
          <h1 className="font-display text-5xl font-extrabold uppercase leading-[0.95] md:text-7xl">
            Pick a side.<br /><span className="text-lime">Put up chips.</span>
          </h1>
          <p className="max-w-md text-lg text-cream-dim">
            Friendly bets and custom draft contests for rivalries that matter. Draft players, write your own scoring, and watch the scoreboard move as results come in.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-lime px-6 py-3 text-lg">Claim your chips</Link>
            <Link href="/signin" className="btn btn-ghost px-6 py-3 text-lg">Sign in</Link>
          </div>
          <p className="text-xs text-cream-faint">Free play chips only — nothing to buy, nothing to cash out.</p>
        </div>
        <div className="card grid gap-3 p-5" aria-hidden="true">
          <div className="chip-label text-cream-faint">Championship draft · Live</div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div><div className="chip-label text-teal">Jordan</div><div className="num font-display text-7xl font-extrabold text-teal">14</div></div>
            <div className="pb-4 font-display text-xl text-cream-faint">VS</div>
            <div className="text-right"><div className="chip-label text-violet">Riley</div><div className="num font-display text-7xl font-extrabold text-violet">11</div></div>
          </div>
          <div className="rounded-lg bg-panel-2 px-3 py-2 text-sm">
            <div className="flex justify-between"><span className="font-semibold">Hana Moriyama</span><span className="num font-bold text-lime">5 pts</span></div>
            <div className="text-xs text-cream-dim">Match win +2 · Upset bonus +3</div>
          </div>
        </div>
      </section>
    );
  }
  const [wallet, mine, pub] = await Promise.all([getWallet(user.id), listContests(user.id, "mine"), listContests(user.id, "public")]);
  const active = mine.filter((c) => !["settled", "canceled"].includes(c.status));
  const done = mine.filter((c) => ["settled", "canceled"].includes(c.status));
  // Every public bet that's still going, including ones you created or joined (they get a "You're in" tag).
  const livePublic = pub.filter((c) => !["settled", "canceled", "setup"].includes(c.status));
  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="font-display text-4xl font-extrabold uppercase">Hey, {user.username}</h1>
          <p className="text-cream-dim">Pick a side. Put up chips.</p>
        </div>
        <Link href="/new" className="btn btn-lime">+ Start a bet</Link>
      </div>
      <ClaimCard canClaim={wallet.can_claim} nextAt={wallet.next_claim_at} serverNow={wallet.server_now} amount={wallet.claim_amount} balance={wallet.balance} staked={wallet.staked} />
      <section className="grid gap-3">
        <h2 className="font-display text-2xl font-bold uppercase">Your contests</h2>
        {active.length ? (
          <div className="grid gap-3 md:grid-cols-2">{active.map((c) => <ContestCard key={c.id} c={c} />)}</div>
        ) : (
          <Empty title="Nothing in play"><Link href="/new" className="link">Start your own bet</Link>, browse public contests, or ask a friend for an invite link.</Empty>
        )}
      </section>
      <section className="grid gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-2xl font-bold uppercase">Public bets</h2>
          {livePublic.length > 6 && <Link href="/browse" className="link text-sm">See all {livePublic.length}</Link>}
        </div>
        {livePublic.length ? (
          <div className="grid gap-3 md:grid-cols-2">{livePublic.slice(0, 6).map((c) => <ContestCard key={c.id} c={c} />)}</div>
        ) : (
          <Empty title="No public bets right now"><Link href="/new" className="link">Start one</Link> and make it public so anyone can jump in.</Empty>
        )}
      </section>
      {done.length > 0 && (
        <section className="grid gap-3">
          <h2 className="font-display text-2xl font-bold uppercase">Finished</h2>
          <div className="grid gap-3 md:grid-cols-2">{done.slice(0, 6).map((c) => <ContestCard key={c.id} c={c} />)}</div>
        </section>
      )}
    </div>
  );
}
