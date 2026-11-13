"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ManageView } from "@/lib/server/manual";
import { act } from "@/lib/client/api";
import { Chips } from "@/components/brand";
import { ErrorNote, StatusPill, pts, sideBorder, sideText } from "@/components/ui";

const SEAT_COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"];
const seatColor = (seat: number) => SEAT_COLORS[(seat - 1) % SEAT_COLORS.length];

type Preview = {
  outcome_id: string | null;
  pot: number;
  summary: string;
  hash: string;
  open_reviews: number;
  lines: { entry_id: string; username: string; status: string; place: number | null; payout: number; refund: number; stake: number; points: number | null }[];
};

/** The organizer's control room for a bet they run by hand. */
export function ManageScreen({ data }: { data: ManageView }) {
  const router = useRouter();
  const { view } = data;
  const c = view.contest;
  const closed = c.status === "settled" || c.status === "canceled";
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const ctx = { busy, run };

  const steps = c.kind === "bet" ? ["Invite", "Lock picks", "Pick winner", "Paid"] : ["Invite", "Rosters", "Scores", "Paid"];
  const stepIdx =
    c.status === "settled" ? 3
    : c.kind === "bet" ? (["locked", "active", "awaiting_settlement"].includes(c.status) ? 2 : c.status === "open" ? 1 : 0)
    : c.status === "active" || c.status === "awaiting_settlement" ? 2 : c.status === "open" ? 1 : 0;

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href={`/c/${c.id}`} className="text-sm text-cream-dim hover:text-cream">← View contest page</Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip-label text-cream-faint">You&apos;re running this · {c.kind === "bet" ? "Pick a side" : "Draft / teams"}</span>
          <StatusPill status={c.status} />
        </div>
        <DetailsEditor contestId={c.id} title={c.title} description={c.description} ctx={ctx} />
        <div className="flex flex-wrap gap-x-4 text-sm text-cream-dim">
          <span>Stake <Chips n={c.stake} className="text-cream" /></span>
          <span>Pot <Chips n={view.pot} className="text-cream" /></span>
          <span className="num">{view.entrants.length} in</span>
        </div>
      </header>

      {!closed && c.status !== "canceled" && (
        <ol className="grid grid-cols-4 gap-1 text-center text-xs font-bold uppercase">
          {steps.map((s, i) => (
            <li key={s} className={`rounded-lg border px-1 py-2 ${i < stepIdx ? "border-lime/40 text-lime" : i === stepIdx ? "border-lime bg-lime/10 text-lime" : "border-line text-cream-faint"}`}>
              {i < stepIdx ? "✓ " : `${i + 1}. `}{s}
            </li>
          ))}
        </ol>
      )}

      <ErrorNote error={err} />

      {c.status === "settled" && (
        <div className="card border-lime/50 bg-lime/5 p-4">
          <div className="font-display text-2xl font-bold uppercase text-lime">Paid out</div>
          <p className="text-sm text-cream-dim">Chips have been sent. Nice work, commish. <Link className="link" href="/achievements">Check your achievements</Link>.</p>
        </div>
      )}
      {c.status === "canceled" && (
        <div className="card border-rose/50 p-4">
          <div className="font-display text-2xl font-bold uppercase text-rose">Canceled</div>
          <p className="text-sm text-cream-dim">Everyone got their stake back.</p>
        </div>
      )}

      {!closed && <StatusPanel data={data} ctx={ctx} />}
      {!closed && <InvitePanel data={data} ctx={ctx} />}
      {!closed && c.kind === "draft" && ["open", "active"].includes(c.status) && <RostersPanel data={data} ctx={ctx} />}
      {!closed && c.kind === "draft" && ["active", "awaiting_settlement"].includes(c.status) && view.rosters.length > 0 && <ScoresPanel data={data} ctx={ctx} />}
      {!closed && (c.kind === "bet" ? ["locked", "active", "awaiting_settlement"].includes(c.status) : c.status === "awaiting_settlement") && <PayoutPanel data={data} ctx={ctx} />}
      {!closed && <CancelPanel data={data} ctx={ctx} />}
    </div>
  );
}

type Ctx = { busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> };

function StatusPanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const c = data.view.contest;
  const n = data.view.entrants.length;
  const setStatus = (status: string) => ctx.run(status, () => act("set_status", { contest_id: c.id, status }));
  let title = "";
  let body: React.ReactNode = null;
  let action: React.ReactNode = null;
  if (c.status === "setup") {
    title = "Ready to open?";
    body = c.kind === "bet" ? <>Sides: {data.view.outcomes.map((o) => o.label).join(" vs ")}. Once it&apos;s open, people you invite can pick a side and put up chips.</> : <>Once it&apos;s open, people you invite can join and put up chips. You&apos;ll enter rosters after.</>;
    action = <button className="btn btn-lime" disabled={!!ctx.busy} onClick={() => setStatus("open")}>Open entries</button>;
  } else if (c.status === "open") {
    if (c.kind === "bet") {
      title = `${n} ${n === 1 ? "person has" : "people have"} picked`;
      body = "When everyone's in (or the game starts), lock it so nobody can switch sides or join late. Picks get revealed when you lock.";
      action = <button className="btn btn-lime" disabled={!!ctx.busy || n < 1} onClick={() => setStatus("locked")}>Lock entries</button>;
    } else {
      title = `${n} ${n === 1 ? "person has" : "people have"} joined`;
      body = n < 2 ? "You need at least two people in before you enter rosters. Joining is on the contest page (you can join your own bet too)." : "Enter everyone's rosters below. Saving them closes entries and starts scoring.";
    }
  } else if (c.status === "locked" || (c.kind === "bet" && c.status === "active")) {
    title = "Entries locked";
    body = "When the result is in, pick the winning side below and pay out.";
  } else if (c.status === "active") {
    title = "Scoring is live";
    body = "Update scores below as results come in. Everyone sees the scoreboard update. When it's over, finish it and pay out.";
    action = <button className="btn btn-lime" disabled={!!ctx.busy} onClick={() => setStatus("awaiting_settlement")}>It&apos;s over → pay out</button>;
  } else if (c.status === "awaiting_settlement") {
    title = "Final check";
    body = c.kind === "draft" ? "Scores are frozen for payout. Need to fix something? Reopen scoring." : "Pick the winner and confirm the payout below.";
    if (c.kind === "draft") action = <button className="btn btn-ghost" disabled={!!ctx.busy} onClick={() => setStatus("active")}>Reopen scoring</button>;
  }
  return (
    <section className="card grid gap-2 border-lime/40 p-4">
      <h2 className="font-display text-2xl font-bold uppercase">{title}</h2>
      {body && <p className="text-sm text-cream-dim">{body}</p>}
      {action && <div className="flex flex-wrap gap-2">{action}{data.view.viewer.join_block === null && <Link href={`/c/${c.id}`} className="btn btn-ghost">Join it yourself</Link>}</div>}
      {!action && data.view.viewer.join_block === null && <Link href={`/c/${c.id}`} className="btn btn-ghost w-fit">Join it yourself</Link>}
    </section>
  );
}

function InvitePanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const c = data.view.contest;
  const [picked, setPicked] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const available = data.friends.filter((f) => !f.invited);
  const invited = data.friends.filter((f) => f.invited);
  const link = data.invites.find((i) => !i.revoked_at);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = link ? `${origin}/invite/${link.token}` : "";
  const entriesOpen = ["setup", "open"].includes(c.status);

  return (
    <section className="card grid gap-4 p-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase">Invite people</h2>
        {!entriesOpen && <p className="text-sm text-amber">Entries are closed, so new people can watch but not join.</p>}
      </div>

      <div className="grid gap-2">
        <div className="label">Friends</div>
        {data.friends.length === 0 ? (
          <p className="text-sm text-cream-dim">No friends yet. <Link className="link" href="/friends">Add some</Link>, or share a link below.</p>
        ) : (
          <>
            {available.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {available.map((f) => {
                  const on = picked.includes(f.user_id);
                  return (
                    <button key={f.user_id} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== f.user_id) : [...picked, f.user_id])}
                      className={`rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-lime bg-lime/10 text-lime" : "border-line text-cream-dim"}`}>
                      {on ? "✓ " : "+ "}{f.username}
                    </button>
                  );
                })}
              </div>
            )}
            {picked.length > 0 && (
              <button className="btn btn-lime w-fit" disabled={!!ctx.busy} onClick={() => ctx.run("friends", async () => { await act("add_friends", { contest_id: c.id, user_ids: picked }); setPicked([]); })}>
                Add {picked.length} {picked.length === 1 ? "friend" : "friends"}
              </button>
            )}
            {invited.length > 0 && (
              <div className="text-sm text-cream-dim">
                Added: {invited.map((f) => <span key={f.user_id} className={`mr-2 ${f.joined ? "text-lime" : ""}`}>{f.username}{f.joined ? " ✓ joined" : ""}</span>)}
              </div>
            )}
            {available.length === 0 && invited.length > 0 && <p className="text-xs text-cream-faint">All your friends are in. They&apos;ll see it on their home page.</p>}
          </>
        )}
      </div>

      <div className="grid gap-2">
        <div className="label">Or share a link</div>
        {link ? (
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-0 flex-1 font-mono text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            <button className="btn btn-ghost" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(link.id); setTimeout(() => setCopied(null), 1500); } catch { /* select-to-copy fallback */ } }}>
              {copied === link.id ? "Copied!" : "Copy"}
            </button>
            <span className="num text-xs text-cream-faint">{link.uses} used</span>
          </div>
        ) : (
          <button className="btn btn-ghost w-fit" disabled={!!ctx.busy} onClick={() => ctx.run("link", () => act("create_invite", { contest_id: c.id, label: "Share link" }))}>Make an invite link</button>
        )}
      </div>
    </section>
  );
}

function RostersPanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const { view } = data;
  const c = view.contest;
  const size = c.roster_size ?? 1;
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.entrants.map((e) => [e.entry_id, view.rosters.find((r) => r.entry_id === e.entry_id)?.picks.map((p) => p.name).join("\n") ?? ""])),
  );
  const [open, setOpen] = useState(c.status === "open");
  const parsed = view.entrants.map((e) => ({ e, picks: (texts[e.entry_id] ?? "").split("\n").map((s) => s.trim()).filter(Boolean) }));
  const all = parsed.flatMap((p) => p.picks.map((x) => x.toLowerCase()));
  const dupes = [...new Set(all.filter((n, i) => all.indexOf(n) !== i))];
  const tooBig = parsed.filter((p) => p.picks.length > size);
  const problems = [...dupes.map((d) => `“${d}” is on more than one roster.`), ...tooBig.map((p) => `${p.e.username} has ${p.picks.length} (max ${size}).`)];

  if (view.entrants.length < 2) return null;
  if (!open) {
    return (
      <section className="card flex flex-wrap items-center gap-3 p-4">
        <h2 className="flex-1 font-display text-2xl font-bold uppercase">Rosters</h2>
        <button className="btn btn-ghost" onClick={() => setOpen(true)}>Edit rosters</button>
      </section>
    );
  }
  return (
    <section className="card grid gap-3 p-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase">Rosters</h2>
        <p className="text-sm text-cream-dim">One player or team per line, up to {size} each.{c.status === "active" ? " Scores you've entered stay attached to each name." : ""}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {view.entrants.map((e) => (
          <label key={e.entry_id} className={`grid gap-1 rounded-xl border-t-4 bg-shell p-3 ${sideBorder[seatColor(e.seat)]}`}>
            <span className={`font-display text-xl font-bold uppercase ${sideText[seatColor(e.seat)]}`}>{e.username}</span>
            <textarea className="input min-h-32 text-sm" value={texts[e.entry_id] ?? ""} onChange={(ev) => setTexts({ ...texts, [e.entry_id]: ev.target.value })} aria-label={`${e.username} roster`} placeholder={"Scottie Scheffler\nRory McIlroy"} />
            <span className="num text-xs text-cream-dim">{parsed.find((p) => p.e.entry_id === e.entry_id)?.picks.length ?? 0} / {size}</span>
          </label>
        ))}
      </div>
      {problems.length > 0 && <ErrorNote error={problems.join(" ")} />}
      <button
        className="btn btn-lime w-fit"
        disabled={!!ctx.busy || problems.length > 0 || parsed.every((p) => p.picks.length === 0)}
        onClick={() => ctx.run("rosters", async () => {
          await act("import_draft", { contest_id: c.id, rosters: parsed.map((p) => ({ entry_id: p.e.entry_id, picks: p.picks })) });
          setOpen(false);
        })}
      >
        {ctx.busy === "rosters" ? "Saving…" : c.status === "open" ? "Save rosters & start scoring" : "Save rosters"}
      </button>
    </section>
  );
}

function ScoresPanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const { view } = data;
  const c = view.contest;
  const frozen = c.status !== "active";
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of view.rosters) for (const p of r.picks) m[p.pool_item_id] = String(p.points);
    return m;
  }, [view.rosters]);
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const changed = Object.keys(vals).filter((k) => vals[k] !== initial[k]);
  const valid = changed.every((k) => vals[k].trim() !== "" && Number.isFinite(Number(vals[k])));
  const totals = view.rosters.map((r) => ({ r, total: r.picks.reduce((s, p) => s + (Number(vals[p.pool_item_id]) || 0), 0) }));
  const best = Math.max(...totals.map((t) => t.total));
  const soleLeader = totals.filter((t) => t.total === best).length === 1;

  return (
    <section className="card grid gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="flex-1 font-display text-2xl font-bold uppercase">Scores</h2>
        {frozen && <span className="chip-label text-amber">Frozen for payout</span>}
      </div>
      <p className="text-sm text-cream-dim">Type each player or team&apos;s total so far. Rosters add up automatically.</p>
      <div className="grid gap-3 md:grid-cols-2">
        {totals.map(({ r, total }) => {
          const seat = view.entrants.find((e) => e.entry_id === r.entry_id)?.seat ?? 1;
          return (
            <div key={r.entry_id} className={`overflow-hidden rounded-xl border-t-4 bg-shell ${sideBorder[seatColor(seat)]}`}>
              <div className="flex items-baseline justify-between px-3 pt-2">
                <span className={`font-display text-xl font-bold uppercase ${sideText[seatColor(seat)]}`}>{r.username}{soleLeader && total === best ? " 👑" : ""}</span>
                <span className="num font-display text-3xl font-extrabold">{pts(total)}</span>
              </div>
              <ul className="divide-y divide-line">
                {r.picks.map((p) => (
                  <li key={p.pool_item_id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="flex-1 text-sm font-semibold">{p.name}</span>
                    <input
                      className={`input w-24 text-right num ${vals[p.pool_item_id] !== initial[p.pool_item_id] ? "border-lime" : ""}`}
                      inputMode="decimal"
                      disabled={frozen}
                      value={vals[p.pool_item_id] ?? "0"}
                      onChange={(e) => setVals({ ...vals, [p.pool_item_id]: e.target.value })}
                      aria-label={`${p.name} score`}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {!frozen && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-lime"
            disabled={!!ctx.busy || changed.length === 0 || !valid}
            onClick={() => ctx.run("scores", () => act("manual_scores", { contest_id: c.id, scores: changed.map((k) => ({ pool_item_id: k, points: Number(vals[k]) })) }))}
          >
            {ctx.busy === "scores" ? "Saving…" : changed.length ? `Save ${changed.length} ${changed.length === 1 ? "change" : "changes"}` : "No changes"}
          </button>
          {!valid && <span className="text-sm text-rose">Scores must be numbers.</span>}
        </div>
      )}
    </section>
  );
}

function PayoutPanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const { view } = data;
  const c = view.contest;
  const [winner, setWinner] = useState<string>(c.result_outcome_id ?? c.proposed_outcome_id ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);

  async function doPreview() {
    if (c.status !== "awaiting_settlement") await act("set_status", { contest_id: c.id, status: "awaiting_settlement" });
    setPreview(await act<Preview>("settlement_preview", { contest_id: c.id, outcome_id: c.kind === "bet" ? winner : null }));
  }

  return (
    <section className="card grid gap-3 border-lime/40 p-4">
      <h2 className="font-display text-2xl font-bold uppercase">{c.kind === "bet" ? "Who won?" : "Pay out"}</h2>
      {c.kind === "bet" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {view.outcomes.map((o) => (
            <button key={o.id} type="button" aria-pressed={winner === o.id} onClick={() => { setWinner(o.id); setPreview(null); }}
              className={`rounded-xl border-2 p-3 text-left ${winner === o.id ? sideBorder[o.color] : "border-line"}`}>
              <div className={`font-display text-2xl font-bold uppercase ${sideText[o.color]}`}>{o.label}</div>
              <div className="text-xs text-cream-dim">{o.count ?? 0} backed this</div>
            </button>
          ))}
        </div>
      )}
      {!preview ? (
        <button className="btn btn-ghost w-fit" disabled={!!ctx.busy || (c.kind === "bet" && !winner)} onClick={() => ctx.run("preview", doPreview)}>
          {ctx.busy === "preview" ? "Working it out…" : "Preview payout"}
        </button>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm">{preview.summary}</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {preview.lines.map((l) => {
              const net = l.payout + l.refund - l.stake;
              return (
                <li key={l.entry_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1 font-semibold">{l.username}</span>
                  {l.points !== null && <span className="num text-cream-dim">{pts(l.points)} pts</span>}
                  <span className="chip-label text-cream-dim">{l.status}</span>
                  <Chips n={net} sign className={net > 0 ? "text-lime" : net < 0 ? "text-rose" : ""} />
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-lime" disabled={!!ctx.busy}
              onClick={() => ctx.run("settle", () => act("settle", { contest_id: c.id, outcome_id: preview.outcome_id, hash: preview.hash }))}>
              {ctx.busy === "settle" ? "Paying…" : `Confirm & pay ${preview.pot.toLocaleString()} chips`}
            </button>
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>Back</button>
          </div>
          <p className="text-xs text-cream-faint">This can&apos;t be undone. Chips go out right away.</p>
        </div>
      )}
    </section>
  );
}

function CancelPanel({ data, ctx }: { data: ManageView; ctx: Ctx }) {
  const c = data.view.contest;
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="flex flex-wrap items-center gap-3 text-sm">
      {confirming ? (
        <>
          <span className="text-cream-dim">Cancel and refund everyone&apos;s stake?</span>
          <button className="btn btn-danger px-3 py-1.5" disabled={!!ctx.busy} onClick={() => ctx.run("cancel", () => act("cancel", { contest_id: c.id, reason: "Canceled by the organizer" }))}>Yes, cancel it</button>
          <button className="text-cream-dim" onClick={() => setConfirming(false)}>Keep it going</button>
        </>
      ) : (
        <button className="text-cream-faint hover:text-rose" onClick={() => setConfirming(true)}>Cancel this bet…</button>
      )}
    </section>
  );
}

/** Title + description, editable by the organizer at any time. */
function DetailsEditor({ contestId, title, description, ctx }: { contestId: string; title: string; description: string; ctx: Ctx }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(title);
  const [d, setD] = useState(description);
  if (!editing) {
    return (
      <div className="grid gap-1">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="font-display text-4xl font-extrabold uppercase leading-none">{title}</h1>
          <button className="btn btn-ghost px-3 py-1 text-sm" onClick={() => { setT(title); setD(description); setEditing(true); }}>Edit title &amp; details</button>
        </div>
        {description ? <p className="max-w-3xl whitespace-pre-line text-cream-dim">{description}</p> : <p className="text-sm text-cream-faint">No details yet.</p>}
      </div>
    );
  }
  const ok = t.trim().length >= 3;
  return (
    <form
      className="card grid gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        ctx.run("details", async () => {
          await act("edit_details", { contest_id: contestId, title: t.trim(), description: d.trim() });
          setEditing(false);
        });
      }}
    >
      <label className="grid gap-1">
        <span className="label">Title</span>
        <input className="input" value={t} maxLength={120} onChange={(e) => setT(e.target.value)} autoFocus />
      </label>
      <label className="grid gap-1">
        <span className="label">Details</span>
        <textarea className="input min-h-24" value={d} maxLength={2000} onChange={(e) => setD(e.target.value)} placeholder="How it's decided, any house rules…" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-lime" disabled={!ok || ctx.busy === "details"}>{ctx.busy === "details" ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        {!ok && <span className="text-sm text-rose">Titles need at least 3 characters.</span>}
        <span className="text-xs text-cream-faint">You can change these anytime, even after people join.</span>
      </div>
    </form>
  );
}
