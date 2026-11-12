import Link from "next/link";
import { redirect } from "next/navigation";
import { Chips } from "@/components/brand";
import { DisplayNameForm } from "@/components/display-name-form";
import { Empty, StatusPill } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { getSessionUser } from "@/lib/server/auth";
import { isAppError } from "@/lib/server/errors";
import { getProfile } from "@/lib/server/profiles";
import { ordinal } from "@/lib/describe";

const RESULT: Record<string, [string, string]> = {
  won: ["W", "text-lime"], lost: ["L", "text-rose"], tied: ["T", "text-amber"], push: ["Push", "text-cream-dim"], refunded: ["Refunded", "text-cream-dim"], active: ["In play", "text-teal"],
};

export default async function Profile({ params, searchParams }: { params: Promise<{ username: string }>; searchParams: Promise<{ vs?: string }> }) {
  const { username } = await params;
  const { vs } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/u/${username}`);
  let data;
  try {
    data = await getProfile(user.id, username);
  } catch (e) {
    if (isAppError(e)) return <Empty title="No such player" />;
    throw e;
  }
  const { profile, stats, history, draftFinishes, h2h } = data;
  const isMe = profile.id === user.id;
  const focus = vs ? h2h.find((h) => h.username === vs) : null;
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <div className="chip-label text-cream-faint">@{profile.username}{profile.is_admin ? " · admin" : ""}</div>
        <h1 className="font-display text-5xl font-extrabold uppercase leading-none">{profile.display_name}</h1>
        {isMe && <DisplayNameForm current={profile.display_name} />}
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Record" value={<span className="num">{stats.wins}-{stats.losses}{stats.ties ? `-${stats.ties}` : ""}</span>} hint="W-L-T, settled only" />
        <Stat label="Completed" value={<span className="num">{stats.completed}</span>} hint={`${stats.bets_completed} bets · ${stats.drafts_completed} drafts`} />
        <Stat label="Net chips" value={<Chips n={stats.net_chips} sign className={stats.net_chips >= 0 ? "text-lime" : "text-rose"} />} hint="payouts + refunds − stakes" />
        <Stat label="In play" value={<span className="num">{stats.in_play}</span>} />
        <Stat label="Canceled" value={<span className="num">{stats.canceled}</span>} hint="not counted in record" />
      </div>

      {focus && (
        <div className="card border-lime/50 p-4">
          <div className="chip-label text-lime">Head-to-head</div>
          <div className="font-display text-3xl font-extrabold uppercase">
            {profile.display_name} <span className="num text-lime">{focus.w}-{focus.l}{focus.t ? `-${focus.t}` : ""}</span> vs {focus.display_name}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="font-display text-xl font-bold uppercase">Head-to-head</h2>
          {h2h.length === 0 ? (
            <p className="text-sm text-cream-dim">No finished contests against anyone yet.</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm">
              {h2h.map((h) => (
                <li key={h.user_id} className="flex items-center gap-2">
                  <Link href={`/u/${profile.username}?vs=${h.username}`} className="flex-1 font-semibold hover:text-lime">vs {h.display_name}</Link>
                  <span className="num font-bold">{h.w}-{h.l}{h.t ? `-${h.t}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-4">
          <h2 className="font-display text-xl font-bold uppercase">Draft finishes</h2>
          {draftFinishes.length === 0 ? (
            <p className="text-sm text-cream-dim">No finished drafts yet.</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm">
              {draftFinishes.map((d) => (
                <li key={d.contest_id} className="flex gap-2">
                  <Link href={`/c/${d.contest_id}`} className="flex-1 hover:text-lime">{d.title}</Link>
                  <span className="num font-bold">{d.place ? ordinal(d.place) : "—"} of {d.of}</span>
                  {d.points !== null && <span className="num text-cream-dim">{d.points} pts</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3 font-display text-xl font-bold uppercase">History</div>
        {history.length === 0 ? (
          <div className="p-4"><Empty title="No contests yet" /></div>
        ) : (
          <ul className="divide-y divide-line">
            {history.map((h) => {
              const [label, cls] = RESULT[h.status] ?? [h.status, ""];
              const net = h.payout + h.refund - h.stake;
              return (
                <li key={h.entry_id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[1fr_auto]">
                  <div>
                    <Link href={`/c/${h.contest_id}`} className="font-semibold hover:text-lime">{h.title}</Link>{" "}
                    <StatusPill status={h.contest_status} />
                    <div className="text-xs text-cream-dim">
                      {h.kind === "bet" ? (h.pick_label ? `Picked: ${h.pick_label}` : "Pick hidden until lock") : h.roster?.length ? `Roster: ${h.roster.join(", ")}` : "No roster yet"}
                      {h.settled_at ? ` · ${fmtTime(h.settled_at)}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 md:justify-end">
                    {h.kind === "draft" && h.place && h.contest_status === "settled" && <span className="num text-cream-dim">{ordinal(h.place)}</span>}
                    <span className={`chip-label ${cls}`}>{label}</span>
                    {h.contest_status === "settled" || h.contest_status === "canceled" ? (
                      <Chips n={net} sign className={net >= 0 ? "text-lime" : "text-rose"} />
                    ) : (
                      <span className="num text-cream-dim">{h.stake} staked</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="chip-label text-cream-faint">{label}</div>
      <div className="font-display text-3xl font-extrabold">{value}</div>
      {hint && <div className="text-xs text-cream-faint">{hint}</div>}
    </div>
  );
}
