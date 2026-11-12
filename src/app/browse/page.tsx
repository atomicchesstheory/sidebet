import Link from "next/link";
import { redirect } from "next/navigation";
import { ContestCard } from "@/components/contest/contest-card";
import { Empty } from "@/components/ui";
import { getSessionUser } from "@/lib/server/auth";
import { listContests } from "@/lib/server/contests";

export const metadata = { title: "Browse" };

const FILTERS: { label: string; q: Record<string, string> }[] = [
  { label: "All", q: {} },
  { label: "Bets", q: { kind: "bet" } },
  { label: "Drafts", q: { kind: "draft" } },
  { label: "Open", q: { status: "open" } },
  { label: "Live", q: { status: "live" } },
  { label: "Finished", q: { status: "done" } },
];

export default async function Browse({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/browse");
  const sp = await searchParams;
  let list = await listContests(user.id, "public");
  if (sp.kind === "bet" || sp.kind === "draft") list = list.filter((c) => c.kind === sp.kind);
  if (sp.status === "open") list = list.filter((c) => c.status === "open");
  if (sp.status === "live") list = list.filter((c) => ["locked", "active", "drafting", "awaiting_settlement"].includes(c.status));
  if (sp.status === "done") list = list.filter((c) => ["settled", "canceled"].includes(c.status));
  const current = JSON.stringify({ ...(sp.kind ? { kind: sp.kind } : {}), ...(sp.status ? { status: sp.status } : {}) });
  return (
    <div className="grid gap-5">
      <h1 className="font-display text-4xl font-extrabold uppercase">Browse public contests</h1>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = JSON.stringify(f.q) === current;
          return (
            <Link key={f.label} href={`/browse?${new URLSearchParams(f.q)}`} className={`rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-lime text-lime" : "border-line text-cream-dim"}`}>
              {f.label}
            </Link>
          );
        })}
      </div>
      {list.length ? <div className="grid gap-3 md:grid-cols-2">{list.map((c) => <ContestCard key={c.id} c={c} />)}</div> : <Empty title="Nothing here yet">Try another filter, or request a contest.</Empty>}
    </div>
  );
}
