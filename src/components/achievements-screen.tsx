"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AchievementView } from "@/lib/server/achievements";
import { act } from "@/lib/client/api";
import { ChipMark, Chips } from "@/components/brand";
import { ErrorNote } from "@/components/ui";

type Data = { items: AchievementView[]; ready: number; earned: number; available: number };

export function AchievementsScreen({ initial, balance: startBalance }: { initial: Data; balance: number }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.items);
  const [balance, setBalance] = useState(startBalance);
  const [busy, setBusy] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ id: string; reward: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ready = items.filter((i) => i.state === "ready");
  const earned = items.filter((i) => i.state === "claimed").reduce((s, i) => s + i.reward, 0);
  // Order is fixed when the page loads so a card stays put while its claim animation plays.
  const [orderIds] = useState(() => {
    const rank = { ready: 0, locked: 1, claimed: 2 } as const;
    return [...initial.items].sort((a, b) => rank[a.state] - rank[b.state] || b.progress / b.target - a.progress / a.target).map((i) => i.id);
  });
  const sorted = orderIds.map((id) => items.find((i) => i.id === id)!).filter(Boolean);

  async function claim(id: string) {
    setBusy(id);
    setErr(null);
    try {
      const r = await act<{ claimed: boolean; reward: number; balance: number }>("claim_achievement", { id });
      setItems((list) => list.map((i) => (i.id === id ? { ...i, state: "claimed", claimed_at: new Date().toISOString() } : i)));
      setBalance(r.balance);
      if (r.reward) {
        setBurst({ id, reward: r.reward });
        setTimeout(() => setBurst(null), 1400);
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="font-display text-4xl font-extrabold uppercase">Achievements</h1>
          <p className="text-cream-dim">Hit milestones, then come here to cash them in for chips.</p>
        </div>
        <div className="card flex items-center gap-3 px-4 py-2">
          <ChipMark size={32} />
          <div>
            <div className="chip-label text-cream-faint">Balance</div>
            <div key={balance} className="bump font-display text-3xl font-extrabold"><Chips n={balance} /></div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Ready to claim" value={<span className={ready.length ? "text-lime" : ""}>{ready.length}</span>} />
        <Tile label="Unlocked" value={<span>{items.filter((i) => i.state === "claimed").length}<span className="text-cream-faint">/{items.length}</span></span>} />
        <Tile label="Chips earned" value={<Chips n={earned} />} hint={`of ${initial.available.toLocaleString()} possible`} />
      </div>

      {ready.length > 0 && (
        <div className="rounded-xl border border-lime/50 bg-lime/10 px-4 py-3 font-display text-xl font-bold uppercase text-lime">
          🎉 {ready.length} {ready.length === 1 ? "reward" : "rewards"} waiting. Tap claim!
        </div>
      )}
      <ErrorNote error={err} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((a) => {
          const pct = Math.round((a.progress / a.target) * 100);
          return (
            <div
              key={a.id}
              className={`card relative grid gap-3 p-4 ${a.state === "ready" ? "ach-ready border-lime" : a.state === "locked" ? "opacity-80" : ""}`}
            >
              <div className="flex items-start gap-3">
                <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-3xl ${a.state === "locked" ? "bg-panel-2 grayscale" : "bg-lime/15"}`}>
                  <span className={a.state === "locked" ? "opacity-50" : ""}>{a.icon}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-2xl font-bold uppercase leading-tight">{a.title}</div>
                  <div className="text-sm text-cream-dim">{a.blurb}</div>
                </div>
              </div>
              {a.state === "locked" && (
                <div className="grid gap-1">
                  <div className="h-2 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={a.progress} aria-valuemax={a.target} aria-label={`${a.title} progress`}>
                    <div className="h-full rounded-full bg-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="num flex justify-between text-xs text-cream-faint">
                    <span>{a.progress.toLocaleString()} / {a.target.toLocaleString()}</span>
                    <span className="flex items-center gap-1">🔒 <Chips n={a.reward} /></span>
                  </div>
                </div>
              )}
              {a.state === "ready" && (
                <button className="btn btn-lime py-3 text-lg" disabled={busy === a.id} onClick={() => claim(a.id)}>
                  {busy === a.id ? "Claiming…" : <>Claim <Chips n={a.reward} sign className="text-ink" /></>}
                </button>
              )}
              {a.state === "claimed" && (
                <div className="flex items-center justify-between text-sm">
                  <span className={`chip-label text-lime ${burst?.id === a.id ? "pop-in" : ""}`}>✓ Claimed</span>
                  <Chips n={a.reward} sign className="text-cream-dim" />
                </div>
              )}
              {burst?.id === a.id && <Burst reward={burst.reward} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A little shower of chips flying out of the card. */
function Burst({ reward }: { reward: number }) {
  const n = Math.min(14, 6 + Math.floor(reward / 10));
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const angle = (i / n) * Math.PI * 2 + (i % 2 ? 0.3 : 0);
        const dist = 70 + ((i * 37) % 50);
        const style = {
          "--dx": `${Math.cos(angle) * dist}px`,
          "--dy": `${Math.sin(angle) * dist - 30}px`,
          "--rot": `${(i * 67) % 360}deg`,
          animationDelay: `${(i % 4) * 40}ms`,
        } as React.CSSProperties;
        return (
          <span key={i} className="chip-fly" style={style}>
            <ChipMark size={18} />
          </span>
        );
      })}
      <span className="pop-in absolute -top-5 right-4 font-display text-3xl font-extrabold text-lime">+{reward}</span>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="chip-label text-cream-faint">{label}</div>
      <div className="font-display text-3xl font-extrabold">{value}</div>
      {hint && <div className="text-xs text-cream-faint">{hint}</div>}
    </div>
  );
}
