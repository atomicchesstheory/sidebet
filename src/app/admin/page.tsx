import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminRequestActions, DemoClock } from "@/components/admin/admin-bits";
import { Empty, StatusPill } from "@/components/ui";
import { ago, fmtTime } from "@/lib/format";
import { adminOverview } from "@/lib/server/admin";
import { getSessionUser } from "@/lib/server/auth";
import { aiMode, config } from "@/lib/server/config";

export const metadata = { title: "Admin" };

export default async function Admin() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/admin");
  if (!user.is_admin) return <Empty title="Admins only">You don&apos;t have admin access.</Empty>;
  const { contests, requests } = await adminOverview(user.id);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-4xl font-extrabold uppercase">Admin</h1>
        <Link href="/admin/new" className="btn btn-lime ml-auto">New contest</Link>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="chip-label rounded-full border border-line px-2 py-1 text-cream-dim">Mode: {config.mode}</span>
        <span className="chip-label rounded-full border border-line px-2 py-1 text-cream-dim">AI: {aiMode() === "claude" ? `Claude (${config.aiModel})` : "demo parser — set ANTHROPIC_API_KEY"}</span>
        <span className="chip-label rounded-full border border-line px-2 py-1 text-cream-dim">Scheduler: {process.env.VERCEL ? "cron route" : config.localScheduler ? `local every ${config.schedulerIntervalSeconds}s` : "off"}</span>
      </div>
      {config.mode === "demo" && <DemoClock />}

      <section className="grid gap-2">
        <h2 className="font-display text-2xl font-bold uppercase">Contests</h2>
        {contests.length === 0 ? (
          <Empty title="No contests yet" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-cream-faint">
                <tr className="border-b border-line">
                  <th className="px-3 py-2">Contest</th><th>Status</th><th>Results</th><th className="num">Entries</th><th>Last good check</th><th>Review</th>
                </tr>
              </thead>
              <tbody>
                {contests.map((c) => (
                  <tr key={c.id} className="border-b border-line/60">
                    <td className="px-3 py-2"><Link href={`/admin/c/${c.id}`} className="font-semibold hover:text-lime">{c.title}</Link><div className="text-xs text-cream-faint">{c.kind} · {c.visibility}</div></td>
                    <td><StatusPill status={c.status} /></td>
                    <td>{c.result_status !== "none" && <StatusPill status={c.result_status} />}{c.last_error && <div className="max-w-48 truncate text-xs text-amber" title={c.last_error}>{c.last_error}</div>}</td>
                    <td className="num">{c.entrants}</td>
                    <td className="text-xs text-cream-dim">{c.last_success_at ? ago(c.last_success_at) : "—"}</td>
                    <td>{c.open_reviews > 0 ? <Link href={`/admin/c/${c.id}?tab=review`} className="chip-label text-amber">{c.open_reviews} open</Link> : <span className="text-cream-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="font-display text-2xl font-bold uppercase">Contest requests</h2>
        {requests.length === 0 ? (
          <Empty title="No requests" />
        ) : (
          <ul className="grid gap-2">
            {requests.map((r) => (
              <li key={r.id} className="card grid gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.title}</span>
                  <span className="text-xs text-cream-faint">by @{r.username} · {fmtTime(r.created_at)}</span>
                  <span className="chip-label ml-auto text-cream-dim">{r.status}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-cream-dim">{r.body}</p>
                {r.status !== "converted" ? <AdminRequestActions id={r.id} status={r.status} /> : r.contest_id && <Link href={`/admin/c/${r.contest_id}`} className="link text-sm">Open contest</Link>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
