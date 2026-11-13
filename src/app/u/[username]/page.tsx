import Link from "next/link";
import { redirect } from "next/navigation";
import { Chips } from "@/components/brand";
import { FriendButton } from "@/components/friends/friend-button";
import { friendStatus } from "@/lib/server/friends";
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
  const focus = vs ? h2h.find((h) => h.username === vs) : null;
  const fStatus = await friendStatus(user.id, profile.id);
  const nemesis = [...h2h].filter((h) => h.l > h.w).sort((a, b) => b.l - b.w - (a.l - a.w))[0];
  const victim = [...h2h].filter((h) => h.w > h.l).sort((a, b) => b.w - b.l - (a.w - a.l))[0];
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        {profile.is_admin && <div className="chip-label text-cream-faint">admin</div>}
        <h1 className="font-display text-5xl font-extrabold uppercase leading-none">{profile.username}</h1>
        <FriendButton userId={profile.id} username={profile.username} status={fStatus} />
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Record" value={<span className="num">{stats.wins}-{stats.losses}{stats.ties ? `-${stats.ties}` : ""}</span>} hint={stats.win_rate === null ? "no finished contests yet" : `${stats.win_rate}% win rate`} />
        <Stat label="Biggest win" value={<Chips n={stats.biggest_win} sign className={stats.biggest_win > 0 ? "text-lime" : ""} />} hint="most chips won in one contest" />
        <Stat label="Chips won" value={<Chips n={stats.chips_won} className={stats.chips_won > 0 ? "text-lime" : ""} />} hint={`net ${stats.net_chips >= 0 ? "+" : ""}${stats.net_chips.toLocaleString()} after losses`} />
        <Stat label="Best streak" value={<span className="num">{stats.best_streak}{stats.current_streak >= 2 ? " 🔥" : ""}</span>} hint={stats.current_streak ? `on a ${stats.current_streak}-win streak now` : "wins in a row"} />
        <Stat label="Biggest pot" value={<Chips n={stats.biggest_pot} />} hint="largest pot played for" />
        <Stat label="In play" value={<span className="num">{stats.in_play}</span>} hint={`${stats.completed} finished`} />
      </div>

      {(nemesis || victim) && (
        <div className="grid gap-3 md:grid-cols-2">
          {nemesis && (
            <Link href={`/u/${profile.username}?vs=${nemesis.username}`} className="card flex items-center gap-3 p-4 hover:border-rose/60">
              <span className="text-3xl">😤</span>
              <div><div className="chip-label text-rose">Nemesis</div><div className="font-display text-2xl font-bold uppercase">{nemesis.username}</div><div className="num text-xs text-cream-dim">{nemesis.w}-{nemesis.l} head-to-head</div></div>
            </Link>
          )}
          {victim && (
            <Link href={`/u/${profile.username}?vs=${victim.username}`} className="card flex items-center gap-3 p-4 hover:border-lime/60">
              <span className="text-3xl">😎</span>
              <div><div className="chip-label text-lime">Favorite victim</div><div className="font-display text-2xl font-bold uppercase">{victim.username}</div><div className="num text-xs text-cream-dim">{victim.w}-{victim.l} head-to-head</div></div>
            </Link>
          )}
        </div>
      )}

      {focus && (
        <div className="card border-lime/50 p-4">
          <div className="chip-label text-lime">Head-to-head</div>
          <div className="font-display text-3xl font-extrabold uppercase">
            {profile.username} <span className="num text-lime">{focus.w}-{focus.l}{focus.t ? `-${focus.t}` : ""}</span> vs {focus.username}
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
                  <Link href={`/u/${profile.username}?vs=${h.username}`} className="flex-1 font-semibold hover:text-lime">vs {h.username}</Link>
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
