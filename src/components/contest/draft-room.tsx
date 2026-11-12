"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { ContestView } from "@/lib/server/contests";
import { act, getJson } from "@/lib/client/api";
import { useContestLive } from "@/lib/client/live";
import { ErrorNote, StatusPill, sideBorder, sideText } from "@/components/ui";

const SEAT_COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"];

export function DraftRoom({ initial }: { initial: ContestView }) {
  const [view, setView] = useState(initial);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = initial.contest.id;
  const refresh = useCallback(async () => {
    try {
      setView(await getJson<ContestView>(`/api/contests/${id}`));
    } catch {}
  }, [id]);
  const live = useContestLive(id, refresh, 5000);
  const d = view.draft!;
  const c = view.contest;
  const entrant = (entryId: string | null) => view.entrants.find((e) => e.entry_id === entryId);
  const color = (entryId: string) => SEAT_COLORS[((entrant(entryId)?.seat ?? 1) - 1) % 6];
  const onClock = entrant(d.on_clock);
  const mine = d.on_clock !== null && d.on_clock === view.viewer.entry_id;
  const canPick = c.status === "drafting" && (mine || view.viewer.is_admin);
  const available = useMemo(
    () => d.pool.filter((p) => !p.drafted_by && (p.name.toLowerCase().includes(q.toLowerCase()) || p.aliases.some((a) => a.toLowerCase().includes(q.toLowerCase())))),
    [d.pool, q],
  );

  async function pick(poolId: string) {
    setBusy(poolId);
    setErr(null);
    try {
      await act("draft_pick", { contest_id: id, pool_item_id: poolId, expected_pick_no: d.next_pick_no });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/c/${id}`} className="text-sm text-cream-dim hover:text-cream">← {c.title}</Link>
        <StatusPill status={c.status} />
        <span className={`chip-label ml-auto ${live === "live" ? "text-lime" : "text-cream-faint"}`}>{live === "live" ? "● Live" : "Polling"}</span>
      </div>

      <div className={`card border-2 p-5 ${mine ? "border-lime" : "border-line"}`}>
        {c.status === "drafting" && onClock ? (
          <>
            <div className="chip-label text-cream-faint">Pick {d.next_pick_no} of {d.total_picks} · {c.draft_format === "snake" ? "Snake" : "Straight"} draft</div>
            <div className="font-display text-5xl font-extrabold uppercase leading-none">
              {mine ? <span className="text-lime">You&apos;re on the clock</span> : <>On the clock: <span className={sideText[color(onClock.entry_id)]}>{onClock.display_name}</span></>}
            </div>
            {view.viewer.is_admin && !mine && <div className="mt-1 text-sm text-amber">Admin: you can make this pick on their behalf.</div>}
          </>
        ) : (
          <div className="font-display text-4xl font-extrabold uppercase">{c.status === "active" ? "Draft complete" : "Draft not live"}</div>
        )}
      </div>
      <ErrorNote error={err} />

      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="card grid content-start gap-3 p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-2xl font-bold uppercase">Available</h2>
            <span className="num text-sm text-cream-dim">{d.pool.filter((p) => !p.drafted_by).length} left</span>
          </div>
          <input className="input" placeholder="Search picks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search picks" />
          <ul className="grid max-h-[60dvh] gap-1 overflow-auto">
            {available.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel-2">
                <span className="flex-1 font-semibold">{p.name}</span>
                {p.seed ? <span className="num rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-bold text-cream-dim">SEED {p.seed}</span> : null}
                <button className="btn btn-lime px-3 py-1 text-sm" disabled={!canPick || busy !== null} onClick={() => pick(p.id)}>
                  {busy === p.id ? "…" : "Draft"}
                </button>
              </li>
            ))}
            {available.length === 0 && <li className="text-sm text-cream-dim">No picks match.</li>}
          </ul>
        </section>

        <section className="grid content-start gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {view.entrants.map((e) => (
              <div key={e.entry_id} className={`card border-t-4 p-3 ${sideBorder[color(e.entry_id)]} ${d.on_clock === e.entry_id ? "ring-1 ring-lime" : ""}`}>
                <div className={`font-display text-xl font-bold uppercase ${sideText[color(e.entry_id)]}`}>{e.display_name}</div>
                <ol className="mt-1 grid gap-0.5 text-sm">
                  {d.picks.filter((p) => p.entry_id === e.entry_id).map((p) => (
                    <li key={p.pick_no}><span className="num mr-2 text-xs text-cream-faint">#{p.pick_no}</span>{d.pool.find((x) => x.id === p.pool_item_id)?.name}</li>
                  ))}
                  {Array.from({ length: Math.max(0, (c.roster_size ?? 0) - d.picks.filter((p) => p.entry_id === e.entry_id).length) }).map((_, i) => (
                    <li key={`e${i}`} className="text-cream-faint">—</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div className="card p-4">
            <h2 className="font-display text-xl font-bold uppercase">Pick history</h2>
            {d.picks.length === 0 ? (
              <div className="text-sm text-cream-dim">No picks yet.</div>
            ) : (
              <ol className="mt-2 grid gap-1 text-sm">
                {[...d.picks].reverse().map((p) => (
                  <li key={p.pick_no} className="flex gap-2">
                    <span className="num w-14 text-cream-faint">R{p.round} #{p.pick_no}</span>
                    <span className={`font-semibold ${sideText[color(p.entry_id)]}`}>{entrant(p.entry_id)?.display_name}</span>
                    <span>{d.pool.find((x) => x.id === p.pool_item_id)?.name}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
