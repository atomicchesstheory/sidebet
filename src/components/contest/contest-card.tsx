import Link from "next/link";
import { Chips } from "@/components/brand";
import { StatusPill } from "@/components/ui";
import { fmtTime } from "@/lib/format";

type C = {
  id: string; title: string; kind: "bet" | "draft"; category: string; visibility: string; status: string;
  stake: number; entrants: number; pot: number; joined: boolean; lock_at: string | null; result_status: string;
};

export function ContestCard({ c }: { c: C }) {
  return (
    <Link href={`/c/${c.id}`} className="card group grid gap-3 p-4 transition hover:border-cream-faint">
      <div className="flex items-center gap-2">
        <span className="chip-label text-cream-faint">{c.kind === "bet" ? "Bet" : "Draft"} · {c.category}</span>
        {c.visibility === "private" && <span className="chip-label text-violet">Private</span>}
        <span className="ml-auto"><StatusPill status={c.status} /></span>
      </div>
      <div className="font-display text-2xl font-bold uppercase leading-tight group-hover:text-lime">{c.title}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-cream-dim">
        <span>Stake <Chips n={c.stake} className="text-cream" /></span>
        <span>Pot <Chips n={c.pot} className="text-cream" /></span>
        <span className="num">{c.entrants} in</span>
        {c.lock_at && c.status === "open" && <span>Locks {fmtTime(c.lock_at)}</span>}
        {c.joined && <span className="chip-label text-lime">You&apos;re in</span>}
      </div>
    </Link>
  );
}
