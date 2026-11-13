import Link from "next/link";
import { redirect } from "next/navigation";
import { RequestForm } from "@/components/request-form";
import { Empty } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { getSessionUser } from "@/lib/server/auth";
import { listRequests } from "@/lib/server/profiles";

export const metadata = { title: "Contest requests" };

const LABEL: Record<string, string> = { submitted: "Submitted", reviewing: "Reviewing", converted: "Live", declined: "Declined" };

export default async function Requests() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/requests");
  const list = await listRequests(user.id);
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
      <section className="grid content-start gap-3">
        <h1 className="font-display text-4xl font-extrabold uppercase">Request a contest</h1>
        <p className="text-cream-dim">Describe a bet or draft in plain English. An admin sets it up, writes the rules and attaches auto-tracked results.</p>
        <p className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-cream-dim">Don&apos;t want to wait? <Link href="/new" className="link">Start a bet yourself</Link> and enter the results by hand.</p>
        <RequestForm />
      </section>
      <section className="grid content-start gap-3">
        <h2 className="font-display text-2xl font-bold uppercase">{user.is_admin ? "All requests" : "Your requests"}</h2>
        {list.length === 0 ? (
          <Empty title="No requests yet" />
        ) : (
          <ul className="grid gap-2">
            {list.map((r) => (
              <li key={r.id} className="card p-4">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{r.title}</span>
                  <span className="ml-auto chip-label text-cream-dim">{LABEL[r.status] ?? r.status}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-cream-dim">{r.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cream-faint">
                  {user.is_admin && <span>@{r.username}</span>}
                  <span>{fmtTime(r.created_at)}</span>
                  {r.admin_note && <span className="text-cream-dim">Admin: {r.admin_note}</span>}
                  {r.contest_id && <Link className="link" href={`/c/${r.contest_id}`}>View contest</Link>}
                  {user.is_admin && r.status !== "converted" && <Link className="link" href={`/admin/new?request=${r.id}`}>Turn into contest</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
