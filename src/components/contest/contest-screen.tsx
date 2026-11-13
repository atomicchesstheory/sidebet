"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContestView } from "@/lib/server/contests";
import { act, getJson } from "@/lib/client/api";
import { useContestLive } from "@/lib/client/live";
import { describeRuleset } from "@/lib/describe";
import type { Ruleset } from "@/lib/scoring/schema";
import { Chips } from "@/components/brand";
import { Countdown, ErrorNote, StatusPill, ago, fmtTime, pts, sideBg, sideBorder, sideText } from "@/components/ui";

const SEAT_COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"];

export function ContestScreen({ initial }: { initial: ContestView }) {
  const [view, setView] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const id = initial.contest.id;
  const refresh = useCallback(async () => {
    try {
      setView(await getJson<ContestView>(`/api/contests/${id}`));
      setErr(null);
    } catch (e) {
      setErr(`Couldn't refresh: ${(e as Error).message}. Showing the last verified scores.`);
    }
  }, [id]);
  const live = useContestLive(id, refresh);
  const c = view.contest;
  const closed = c.status === "settled" || c.status === "canceled";

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip-label text-cream-faint">{c.kind === "bet" ? "Bet" : "Draft"} · {c.category}</span>
          {c.visibility === "private" && <span className="chip-label text-violet">Private</span>}
          <StatusPill status={c.status} />
          {!closed && c.result_status !== "none" && <StatusPill status={c.result_status} />}
          <span className={`chip-label ml-auto flex items-center gap-1 ${live === "live" ? "text-lime" : "text-cream-faint"}`} title="Live updates">
            <span className={`inline-block h-2 w-2 rounded-full ${live === "live" ? "bg-lime" : "bg-cream-faint"}`} />
            {live === "live" ? "Live" : live === "polling" ? "Polling" : "Connecting"}
          </span>
        </div>
        <h1 className="font-display text-4xl font-extrabold uppercase leading-none md:text-5xl">{c.title}</h1>
        {c.description && <p className="max-w-3xl whitespace-pre-line text-cream-dim">{c.description}</p>}
        {c.manual && view.organizer && (
          <div className="text-sm text-cream-dim">Run by <Link href={`/u/${view.organizer}`} className="font-semibold text-cream hover:text-lime">{view.organizer}</Link> · results entered by hand</div>
        )}
        {c.manual && view.viewer.can_manage && !closed && (
          <div className="flex flex-wrap gap-2">
            <Link href={`/c/${c.id}/manage`} className="btn btn-lime px-3 py-1.5 text-sm">Run this bet</Link>
          </div>
        )}
        {!c.manual && view.viewer.is_admin && (
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/c/${c.id}`} className="btn btn-ghost px-3 py-1.5 text-sm">Manage contest</Link>
            {view.open_reviews > 0 && <Link href={`/admin/c/${c.id}?tab=review`} className="btn btn-ghost px-3 py-1.5 text-sm text-amber">{view.open_reviews} to review</Link>}
          </div>
        )}
      </header>

      <ErrorNote error={err} />
      <ClosedBanner view={view} />

      {c.kind === "draft" ? <DraftBoard view={view} /> : <BetBoard view={view} onChanged={refresh} />}

      {c.kind === "draft" && view.viewer.join_block === null && <JoinPanel view={view} onChanged={refresh} />}

      <div className="grid gap-4 md:grid-cols-3">
        <TermsCard view={view} />
        <ResultsCard view={view} />
        <ActivityCard view={view} />
      </div>
      {view.events.length > 0 && <EventsCard view={view} />}
    </div>
  );
}

function ClosedBanner({ view }: { view: ContestView }) {
  const c = view.contest;
  if (c.status === "canceled")
    return (
      <div className="card border-rose/50 p-4">
        <div className="font-display text-2xl font-bold uppercase text-rose">Canceled</div>
        <p className="text-sm text-cream-dim">{c.cancel_reason || "This contest was canceled."} Every stake was refunded. It doesn&apos;t count toward records.</p>
      </div>
    );
  if (c.status !== "settled") return null;
  const winners = view.entrants.filter((e) => e.payout > 0);
  const outcome = view.outcomes.find((o) => o.id === c.result_outcome_id);
  const pushed = view.entrants.every((e) => e.status === "push");
  return (
    <div className="card border-lime/50 bg-lime/5 p-4">
      <div className="chip-label text-lime">Settled {fmtTime(c.settled_at)}</div>
      <div className="font-display text-3xl font-extrabold uppercase">
        {outcome ? `${outcome.label}` : winners.length === 1 ? `${winners[0].username} wins` : winners.length > 1 ? "Tied — pot split" : "Final"}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
        {pushed ? (
          <span className="text-cream-dim">Nobody picked the winning outcome — every stake was refunded.</span>
        ) : (
          view.entrants.map((e) => (
            <span key={e.entry_id} className={e.payout > 0 ? "text-lime" : "text-cream-dim"}>
              {e.username} <span className="num">{e.payout - e.stake + e.refund >= 0 ? "+" : ""}{e.payout - e.stake + e.refund}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ draft --
function seatColor(view: ContestView, entryId: string) {
  const e = view.entrants.find((x) => x.entry_id === entryId);
  return SEAT_COLORS[((e?.seat ?? 1) - 1) % SEAT_COLORS.length];
}

function useBump(value: number) {
  const prev = useRef(value);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setBump(true);
      const t = setTimeout(() => setBump(false), 700);
      return () => clearTimeout(t);
    }
  }, [value]);
  return bump;
}

function BigScore({ value, color, align = "left" }: { value: number; color: string; align?: "left" | "right" }) {
  const bump = useBump(value);
  return <div className={`num font-display text-7xl font-extrabold leading-none md:text-8xl ${sideText[color]} ${bump ? "bump" : ""} ${align === "right" ? "text-right" : ""}`}>{pts(value)}</div>;
}

function DraftBoard({ view }: { view: ContestView }) {
  const c = view.contest;
  const rosters = view.rosters;
  const [selected, setSelected] = useState<string | null>(view.viewer.entry_id ?? rosters[0]?.entry_id ?? null);
  const hasPicks = (view.draft?.picks.length ?? 0) > 0;

  if (!hasPicks) {
    return (
      <section className="card grid gap-3 p-5">
        <div className="font-display text-2xl font-bold uppercase">{c.status === "drafting" ? "Draft is live" : "Waiting for the draft"}</div>
        <p className="text-cream-dim">
          {c.status === "drafting"
            ? "Picks are happening now."
            : c.manual
              ? `${view.organizer ?? "The organizer"} enters everyone's rosters once people have joined.`
              : c.draft_mode === "offline"
              ? "Rosters were drafted offline. The commish will load them before scoring starts."
              : "The live draft starts once everyone is in."}
        </p>
        <Entrants view={view} />
        {c.status === "drafting" && <Link href={`/c/${c.id}/draft`} className="btn btn-lime w-fit">Go to the draft board</Link>}
      </section>
    );
  }

  const two = rosters.length === 2;
  const leader = rosters[0];
  const tiedTop = rosters.filter((r) => r.place === 1).length > 1;
  const margin = two ? Math.abs(rosters[0].total - rosters[1].total) : 0;
  const final = c.status === "settled";
  const ordered = two ? [...rosters].sort((a, b) => seatOf(view, a.entry_id) - seatOf(view, b.entry_id)) : rosters;

  return (
    <section className="grid gap-4">
      {c.status === "drafting" && (
        <Link href={`/c/${c.id}/draft`} className="card flex items-center justify-between border-lime/50 p-3">
          <span className="font-display text-xl font-bold uppercase">Draft in progress</span>
          <span className="btn btn-lime px-3 py-1.5 text-sm">Open draft board</span>
        </Link>
      )}
      {/* Scoreboard: who's ahead, at a glance */}
      <div className="card sticky top-[57px] z-20 p-4 md:static md:p-6">
        {two ? (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            {ordered.map((r, i) => (
              <div key={r.entry_id} className={i === 1 ? "order-3 text-right" : ""}>
                <div className={`chip-label ${sideText[seatColor(view, r.entry_id)]}`}>
                  {r.username}{r.user_id === view.viewer.id ? " · you" : ""}
                </div>
                <BigScore value={r.total} color={seatColor(view, r.entry_id)} align={i === 1 ? "right" : "left"} />
              </div>
            ))}
            <div className="order-2 pb-3 text-center font-display text-lg text-cream-faint">VS</div>
          </div>
        ) : (
          <div className="grid gap-1">
            {rosters.map((r) => (
              <button key={r.entry_id} onClick={() => { setSelected(r.entry_id); document.getElementById(`roster-${r.entry_id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-left ${selected === r.entry_id ? "bg-panel-2" : ""}`}>
                <span className="num w-8 font-display text-2xl font-bold text-cream-faint">{r.place}</span>
                <span className={`flex-1 font-semibold ${sideText[seatColor(view, r.entry_id)]}`}>{r.username}{r.tied ? " (tied)" : ""}{r.user_id === view.viewer.id ? " · you" : ""}</span>
                <span className="num font-display text-3xl font-extrabold">{pts(r.total)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-display text-xl font-bold uppercase">
            {tiedTop ? (final ? "Finished tied" : "Tied") : `${leader.username} ${final ? "wins" : "leads"}${two ? ` by ${pts(margin)}` : ""}`}
          </span>
          <span className="text-cream-dim">Pot <Chips n={view.pot} className="text-cream" /> · {view.terms.payout}</span>
          {view.ruleset && <ScoringButton view={view} />}
        </div>
      </div>

      {/* Rosters: side by side on desktop, switchable on mobile */}
      {two && (
        <div className="flex gap-2 md:hidden" role="tablist">
          {ordered.map((r) => (
            <button key={r.entry_id} role="tab" aria-selected={selected === r.entry_id} onClick={() => setSelected(r.entry_id)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold ${selected === r.entry_id ? `${sideBorder[seatColor(view, r.entry_id)]} ${sideText[seatColor(view, r.entry_id)]}` : "border-line text-cream-dim"}`}>
              {r.username} · <span className="num">{pts(r.total)}</span>
            </button>
          ))}
        </div>
      )}
      {/* Every player's roster and score, all at once */}
      {!two && <h2 className="font-display text-2xl font-bold uppercase">Every roster</h2>}
      <div className={`grid gap-4 ${two ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
        {(two ? ordered : rosters).map((r) => (
          <div key={r.entry_id} id={`roster-${r.entry_id}`} className={two && selected !== r.entry_id ? "hidden md:block" : ""}>
            <RosterCard view={view} roster={r} highlight={!two && selected === r.entry_id} />
          </div>
        ))}
      </div>
    </section>
  );
}

function seatOf(view: ContestView, entryId: string) {
  return view.entrants.find((e) => e.entry_id === entryId)?.seat ?? 0;
}

function RosterCard({ view, roster, highlight = false }: { view: ContestView; roster: ContestView["rosters"][number]; highlight?: boolean }) {
  const color = seatColor(view, roster.entry_id);
  return (
    <div className={`card overflow-hidden border-t-4 ${sideBorder[color]} ${highlight ? "ring-2 ring-cream/30" : ""}`}>
      <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
        <div>
          <div className={`font-display text-2xl font-bold uppercase ${sideText[color]}`}>{roster.username}</div>
          <div className="text-xs text-cream-dim">
            {roster.place === 1 && !roster.tied ? "1st" : roster.tied ? `Tied ${roster.place}` : `#${roster.place}`} · {roster.picks.length} picks
          </div>
        </div>
        <div className="num font-display text-4xl font-extrabold">{pts(roster.total)}<span className="ml-1 text-base text-cream-dim">pts</span></div>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {roster.picks.map((p) => (
          <li key={p.pool_item_id}>
            <details className="group">
              <summary className="flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2">
                <span className="num w-6 text-xs text-cream-faint">#{p.pick_no}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{p.name}</span>
                  {p.seed ? <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-bold text-cream-dim">SEED {p.seed}</span> : null}
                  {p.lines.length > 0 && (
                    <span className="block truncate text-xs text-cream-dim">{p.lines.map((l) => `${l.label} ${l.points >= 0 ? "+" : ""}${pts(l.points)}`).join(" · ")}</span>
                  )}
                </span>
                <span className={`num font-display text-2xl font-bold ${p.points > 0 ? "text-cream" : "text-cream-faint"}`}>{pts(p.points)}</span>
                <span className="text-xs text-cream-faint">pts</span>
                <span className="text-cream-faint transition group-open:rotate-90">›</span>
              </summary>
              <div className="bg-shell px-4 py-3 text-sm">
                {p.lines.length === 0 ? (
                  <div className="text-cream-dim">No scoring events yet.</div>
                ) : (
                  <ul className="grid gap-2">
                    {p.lines.map((l) => (
                      <li key={l.id} className="grid grid-cols-[1fr_auto] gap-x-3">
                        <div>
                          <div className="font-semibold">{l.label}</div>
                          <div className="text-xs text-cream-dim">
                            {l.kind === "adjustment" ? `Admin adjustment: ${l.detail}` : l.detail}
                            {l.source_url && (
                              <>
                                {" · "}
                                {/^https?:/.test(l.source_url) ? <a className="link" href={l.source_url} target="_blank" rel="noreferrer">source</a> : <span>{l.source_url.startsWith("fixture:") ? "demo feed" : "source"}</span>}
                              </>
                            )}
                          </div>
                        </div>
                        <div className="num font-bold text-lime">{l.points >= 0 ? "+" : ""}{pts(l.points)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
      {roster.entry_adjustments.length > 0 && (
        <div className="border-t border-line px-4 py-2 text-xs text-cream-dim">
          {roster.entry_adjustments.map((a) => (
            <div key={a.id}>Roster adjustment {a.points >= 0 ? "+" : ""}{pts(a.points)}: {a.detail}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Entrants({ view }: { view: ContestView }) {
  if (!view.entrants.length) return <div className="text-sm text-cream-dim">Nobody&apos;s in yet.</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {view.entrants.map((e) => (
        <Link key={e.entry_id} href={`/u/${e.username}`} className={`rounded-full border px-3 py-1 text-sm font-semibold ${sideBorder[SEAT_COLORS[(e.seat - 1) % 6]]} ${sideText[SEAT_COLORS[(e.seat - 1) % 6]]}`}>
          {e.username}
        </Link>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- bet --
function BetBoard({ view, onChanged }: { view: ContestView; onChanged: () => void }) {
  const c = view.contest;
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canJoin = view.viewer.join_block === null;
  const lc = c.live_context;
  const proposed = view.outcomes.find((o) => o.id === c.proposed_outcome_id);

  async function join() {
    if (!choice) return;
    setBusy(true);
    setErr(null);
    try {
      await act("join", { contest_id: c.id, outcome_id: choice });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4">
      {lc && (
        <div className="card p-4 md:p-6">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="chip-label text-cream-faint">{lc.label}</span>
            <StatusPill status={lc.status} />
            {lc.attributes?.detail ? <span className="text-xs text-cream-dim">{String(lc.attributes.detail)}</span> : null}
            {lc.status === "in_progress" && lc.attributes?.clock ? <span className="num text-xs text-cream-dim">{lc.attributes.period ? `P${String(lc.attributes.period)} · ` : ""}{String(lc.attributes.clock)}</span> : null}
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            {lc.participants.slice(0, 2).map((p, i) => (
              <div key={p.name} className={i === 1 ? "order-3 text-right" : ""}>
                <div className={`chip-label ${lc.leader === p.name ? "text-lime" : "text-cream-dim"}`}>{p.name}</div>
                <div className={`num font-display text-6xl font-extrabold leading-none md:text-7xl ${lc.leader === p.name ? "text-cream" : "text-cream-dim"}`}>{p.score ?? "–"}</div>
              </div>
            ))}
            <div className="order-2 pb-2 font-display text-lg text-cream-faint">VS</div>
          </div>
          <div className="mt-3 text-sm">
            <span className="font-display text-xl font-bold uppercase">
              {lc.status === "scheduled" ? "Not started" : lc.winner ? `${lc.winner} won` : lc.leader ? `${lc.leader} ${lc.status === "final" ? "won" : "ahead"}` : lc.tied ? "All square" : ""}
            </span>
            <span className="ml-2 text-cream-dim">
              {proposed ? `Result: ${proposed.label} — awaiting admin settlement` : c.status === "settled" ? "" : "Outcome pending until the evidence is final."}
            </span>
          </div>
        </div>
      )}

      <WhoIsIn view={view} />

      <div className="grid gap-3 md:grid-cols-2">
        {view.outcomes.map((o) => {
          const mine = view.my_pick === o.id;
          const won = c.result_outcome_id === o.id;
          const selectedNow = choice === o.id;
          return (
            <div key={o.id} className={`card relative grid gap-3 border-2 p-4 ${mine || selectedNow ? sideBorder[o.color] : "border-line"} ${won ? "ring-2 ring-lime" : ""}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${sideBg[o.color]}`} />
                <div className={`font-display text-3xl font-extrabold uppercase leading-none ${sideText[o.color]}`}>{o.label}</div>
                <div className="ml-auto flex gap-1">
                  {mine && <span className="chip-label rounded bg-lime px-1.5 py-0.5 text-ink">Your pick</span>}
                  {won && <span className="chip-label rounded bg-cream px-1.5 py-0.5 text-ink">Winner</span>}
                  {proposed?.id === o.id && !won && <span className="chip-label rounded border border-amber px-1.5 py-0.5 text-amber">Result</span>}
                </div>
              </div>
              <div className="text-sm">
                {o.count === null ? (
                  <span className="text-cream-dim">🔒 Picks revealed when entries lock{mine ? " — yours is safe with us" : ""}.</span>
                ) : o.backers.length === 0 ? (
                  <span className="text-cream-dim">Nobody backed this side.</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="num font-bold">{o.count}</span>
                    <span className="text-cream-dim">backed by</span>
                    {o.backers.map((b) => (
                      <Link key={b.user_id} href={`/u/${b.username}`} className="rounded-full bg-panel-2 px-2 py-0.5 text-xs font-semibold">{b.username}</Link>
                    ))}
                  </div>
                )}
              </div>
              {canJoin && (
                <button className={`btn ${selectedNow ? "btn-lime" : "btn-ghost"}`} onClick={() => setChoice(o.id)} aria-pressed={selectedNow}>
                  {selectedNow ? "Picked" : "Pick a side"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {canJoin ? (
        <div className="card grid gap-3 p-4">
          <TermsSummary view={view} />
          <ErrorNote error={err} />
          <button className="btn btn-lime py-3 text-lg" disabled={!choice || busy} onClick={join}>
            {busy ? "Placing…" : choice ? `Put up ${c.stake} chips` : "Pick a side first"}
          </button>
        </div>
      ) : view.viewer.join_block === "closed" && !view.viewer.entry_id && c.status !== "settled" && c.status !== "canceled" ? (
        <div className="card p-4 text-sm text-cream-dim">🔒 Entries are locked.</div>
      ) : null}
    </section>
  );
}

/** Who has joined a bet. Names are always visible; which side they took stays hidden until entries lock. */
function WhoIsIn({ view }: { view: ContestView }) {
  const n = view.entrants.length;
  const hidden = !view.picks_visible && !view.viewer.is_admin;
  return (
    <div className="card grid gap-2 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-xl font-bold uppercase">Who&apos;s in</h2>
        <span className="num text-sm text-cream-dim">{n} {n === 1 ? "player" : "players"} · pot <Chips n={view.pot} className="text-cream" /></span>
        {hidden && n > 0 && <span className="ml-auto text-xs text-cream-faint">🔒 Picks stay secret until entries lock</span>}
      </div>
      {n === 0 ? (
        <p className="text-sm text-cream-dim">Nobody&apos;s in yet. Be the first.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {view.entrants.map((e) => {
            const pick = view.outcomes.find((o) => o.backers.some((b) => b.user_id === e.user_id));
            const showPick = pick && (!hidden || e.user_id === view.viewer.id);
            return (
              <Link key={e.entry_id} href={`/u/${e.username}`} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${showPick ? sideBorder[pick.color] : "border-line"}`}>
                <span>{e.username}{e.user_id === view.viewer.id ? " (you)" : ""}</span>
                {showPick ? <span className={`text-xs ${sideText[pick.color]}`}>· {pick.label}</span> : hidden ? <span className="text-xs text-cream-faint">· 🔒</span> : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JoinPanel({ view, onChanged }: { view: ContestView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card grid gap-3 p-4">
      <div className="font-display text-2xl font-bold uppercase">Join this draft</div>
      <TermsSummary view={view} />
      <ErrorNote error={err} />
      <button
        className="btn btn-lime py-3 text-lg"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await act("join", { contest_id: view.contest.id });
            onChanged();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Joining…" : `Put up ${view.contest.stake} chips`}
      </button>
    </div>
  );
}

/** Shown before anyone enters: stake, payout, lock, tie and cancel terms. */
function TermsSummary({ view }: { view: ContestView }) {
  const c = view.contest;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div><dt className="chip-label text-cream-faint">Entry stake</dt><dd><Chips n={c.stake} /></dd></div>
      <div><dt className="chip-label text-cream-faint">Payout</dt><dd>{view.terms.payout}</dd></div>
      <div>
        <dt className="chip-label text-cream-faint">Locks</dt>
        <dd>{c.lock_at ? <>{fmtTime(c.lock_at)} · <Countdown to={c.lock_at} serverNow={view.server_now} done="locked" /></> : "When the commish locks it"}</dd>
      </div>
      <div><dt className="chip-label text-cream-faint">Picks visible</dt><dd>{c.pick_visibility === "always" ? "Right away" : "After entries lock"}</dd></div>
      <div className="sm:col-span-2"><dt className="chip-label text-cream-faint">Ties</dt><dd className="text-cream-dim">{view.terms.tie}</dd></div>
      <div className="sm:col-span-2"><dt className="chip-label text-cream-faint">Cancellation</dt><dd className="text-cream-dim">{view.terms.cancel}</dd></div>
      {c.terms_text && <div className="sm:col-span-2"><dt className="chip-label text-cream-faint">House rules</dt><dd className="text-cream-dim">{c.terms_text}</dd></div>}
      {c.kind === "draft" && view.ruleset && (
        <div className="sm:col-span-2"><dt className="chip-label text-cream-faint">Scoring</dt><dd className="text-cream-dim">{describeRuleset(view.ruleset.rules as Ruleset).slice(0, 3).join(" · ")}</dd></div>
      )}
    </dl>
  );
}

// ------------------------------------------------------------- side cards --
function ScoringButton({ view }: { view: ContestView }) {
  const [open, setOpen] = useState(false);
  const rs = view.ruleset!;
  return (
    <>
      <button className="link ml-auto text-sm font-semibold" onClick={() => setOpen(true)}>View scoring</button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="card max-h-[85dvh] w-full max-w-lg overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl font-bold uppercase">Scoring</h2>
              <button className="btn btn-ghost px-2 py-1 text-sm" onClick={() => setOpen(false)}>Close</button>
            </div>
            <div className="mt-3 chip-label text-cream-faint">In the commish&apos;s words</div>
            <blockquote className="mt-1 border-l-2 border-lime pl-3 text-cream">{rs.instructions}</blockquote>
            <div className="mt-4 chip-label text-cream-faint">How the app applies it (v{rs.version}, approved {fmtTime(rs.approved_at)})</div>
            <ul className="mt-1 grid list-disc gap-1 pl-5 text-sm">
              {describeRuleset(rs.rules as Ruleset).map((l) => <li key={l}>{l}</li>)}
            </ul>
            {Object.entries(rs.answers ?? {}).filter(([k]) => !k.startsWith("__")).length > 0 && (
              <>
                <div className="mt-4 chip-label text-cream-faint">Clarifications</div>
                <ul className="mt-1 grid gap-1 text-sm text-cream-dim">
                  {Object.entries(rs.answers).filter(([k]) => !k.startsWith("__")).map(([k, v]) => <li key={k}><span className="text-cream">{k}:</span> {v}</li>)}
                </ul>
              </>
            )}
            {(rs.unsupported as { text: string }[]).length > 0 && (
              <>
                <div className="mt-4 chip-label text-amber">Handled by admin adjustments</div>
                <ul className="mt-1 text-sm text-cream-dim">{(rs.unsupported as { text: string }[]).map((u) => <li key={u.text}>{u.text}</li>)}</ul>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TermsCard({ view }: { view: ContestView }) {
  return (
    <div className="card grid gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-bold uppercase">Terms</h2>
        {view.contest.terms_locked_at && <span className="chip-label text-cream-faint">🔒 Locked {fmtTime(view.contest.terms_locked_at)}</span>}
      </div>
      <TermsSummary view={view} />
      <div className="text-sm">Pot <Chips n={view.pot} /> from {view.entrants.length} {view.entrants.length === 1 ? "entry" : "entries"}</div>
      {view.contest.kind === "draft" && !view.rosters.length ? <Entrants view={view} /> : null}
    </div>
  );
}

function ResultsCard({ view }: { view: ContestView }) {
  const c = view.contest;
  return (
    <div className="card grid content-start gap-2 p-4 text-sm">
      <h2 className="font-display text-xl font-bold uppercase">Results</h2>
      {c.manual ? (
        <>
          <div className="text-cream-dim">Scores and the winner are entered by hand by {view.organizer ?? "the organizer"}.</div>
          <div><span className="text-cream-dim">Last update:</span> <span className="num">{c.last_success_at ? ago(c.last_success_at, view.server_now) : "no scores yet"}</span></div>
        </>
      ) : (<>
      <div className="flex items-center gap-2">
        <span className="text-cream-dim">Standing:</span>
        <StatusPill status={c.status === "settled" ? "final" : c.result_status === "none" ? "scheduled" : c.result_status} />
      </div>
      <div><span className="text-cream-dim">Last successful check:</span> <span className="num">{c.last_success_at ? `${ago(c.last_success_at, view.server_now)} (${fmtTime(c.last_success_at)})` : "not yet"}</span></div>
      {c.last_check_at && c.last_check_at !== c.last_success_at && <div><span className="text-cream-dim">Last attempt:</span> {ago(c.last_check_at, view.server_now)}</div>}
      {c.last_error && (
        <div className="rounded-lg border border-amber/40 bg-amber/10 px-2 py-1 text-xs text-amber">
          Source problem: {c.last_error}. Showing the last verified scores.
        </div>
      )}
      </>)}
      {c.kind === "draft" && view.ruleset && <ScoringButton view={view} />}
    </div>
  );
}

function ActivityCard({ view }: { view: ContestView }) {
  return (
    <div className="card grid content-start gap-2 p-4">
      <h2 className="font-display text-xl font-bold uppercase">What changed</h2>
      {view.changes.length === 0 ? (
        <div className="text-sm text-cream-dim">No score changes yet.</div>
      ) : (
        <ul className="grid gap-2 text-sm">
          {view.changes.slice(0, 8).map((ch) => (
            <li key={ch.id}>
              <span className={`chip-label mr-1 ${ch.kind === "correction" ? "text-amber" : ch.kind === "review" ? "text-rose" : "text-teal"}`}>{ch.kind}</span>
              {ch.summary}
              <div className="text-xs text-cream-faint">{ago(ch.created_at, view.server_now)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventsCard({ view }: { view: ContestView }) {
  return (
    <details className="card">
      <summary className="flex items-center justify-between px-4 py-3">
        <span className="font-display text-xl font-bold uppercase">Events ({view.events.length})</span>
        <span className="text-sm text-cream-dim">Show</span>
      </summary>
      <ul className="divide-y divide-line border-t border-line text-sm">
        {view.events.map((e) => {
          const f = e.facts as { participants?: { name: string; score?: unknown; result?: string | null }[]; round?: string | null; bracket?: string | null } | null;
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <span className="font-semibold">{e.label || e.event_key}</span>
              <StatusPill status={e.status} />
              {f?.round && <span className="text-xs text-cream-dim">{f.round}{f.bracket ? ` · ${f.bracket}` : ""}</span>}
              <span className="num ml-auto text-xs text-cream-dim">
                {f?.participants?.map((p) => `${p.name}${p.score != null ? ` ${String(p.score)}` : ""}${p.result === "win" ? " ✓" : ""}`).join(" — ")}
              </span>
              {e.revision > 1 && <span className="chip-label text-amber">rev {e.revision}</span>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
