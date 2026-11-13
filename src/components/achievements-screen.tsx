"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AchievementView, FamilyView } from "@/lib/server/achievements";
import { act } from "@/lib/client/api";
import { ChipMark, Chips } from "@/components/brand";
import { ErrorNote } from "@/components/ui";

type Data = { families: FamilyView[]; items: AchievementView[]; ready: number; earned: number; available: number };

const TIER_STYLE = [
  { name: "Bronze", ring: "border-amber/60", text: "text-amber" },
  { name: "Silver", ring: "border-cream-dim/60", text: "text-cream" },
  { name: "Gold", ring: "border-lime/70", text: "text-lime" },
];

export function AchievementsScreen({ initial, balance: startBalance }: { initial: Data; balance: number }) {
  const router = useRouter();
  const [families, setFamilies] = useState(initial.families);
  const [balance, setBalance] = useState(startBalance);
  const [busy, setBusy] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ id: string; family: string; reward: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tiers = families.flatMap((f) => f.tiers);
  const ready = tiers.filter((t) => t.state === "ready");
  const earned = tiers.filter((t) => t.state === "claimed").reduce((s, t) => s + t.reward, 0);
  // Order is fixed when the page loads so a card stays put while its claim animation plays.
  const [orderIds] = useState(() => {
    const score = (f: FamilyView) => {
      if (f.tiers.some((t) => t.state === "ready")) return 0;
      if (f.tiers.every((t) => t.state === "claimed")) return 2;
      return 1;
    };
    const nextPct = (f: FamilyView) => {
      const next = f.tiers.find((t) => t.state !== "claimed");
      return next ? next.progress / next.target : 1;
    };
    return [...initial.families].sort((a, b) => score(a) - score(b) || nextPct(b) - nextPct(a)).map((f) => f.id);
  });
  const sorted = orderIds.map((id) => families.find((f) => f.id === id)!).filter(Boolean);

  async function claim(t: AchievementView) {
    setBusy(t.id);
    setErr(null);
    try {
      const r = await act<{ claimed: boolean; reward: number; balance: number }>("claim_achievement", { id: t.id });
      setFamilies((list) =>
        list.map((f) => (f.id !== t.family ? f : { ...f, tiers: f.tiers.map((x) => (x.id === t.id ? { ...x, state: "claimed", claimed_at: new Date().toISOString() } : x)) })),
      );
      setBalance(r.balance);
      if (r.reward) {
        setBurst({ id: t.id, family: t.family, reward: r.reward });
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
          <p className="text-cream-dim">Every achievement has three tiers. Each tier is 3× then 10× harder, for 3× then 10× the chips.</p>
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
        <Tile label="Tiers unlocked" value={<span>{tiers.filter((t) => t.state === "claimed").length}<span className="text-cream-faint">/{tiers.length}</span></span>} />
        <Tile label="Chips earned" value={<Chips n={earned} />} hint={`of ${initial.available.toLocaleString()} possible`} />
      </div>

      {ready.length > 0 && (
        <div className="rounded-xl border border-lime/50 bg-lime/10 px-4 py-3 font-display text-xl font-bold uppercase text-lime">
          🎉 {ready.length} {ready.length === 1 ? "reward" : "rewards"} waiting. Tap claim!
        </div>
      )}
      <ErrorNote error={err} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((f) => {
          const done = f.tiers.filter((t) => t.state === "claimed").length;
          const next = f.tiers.find((t) => t.state === "locked");
          const anyUnlocked = f.tiers.some((t) => t.state !== "locked");
          return (
            <div key={f.id} className={`card relative grid content-start gap-3 p-4 ${f.tiers.some((t) => t.state === "ready") ? "ach-ready border-lime" : ""}`}>
              <div className="flex items-start gap-3">
                <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-3xl ${anyUnlocked ? "bg-lime/15" : "bg-panel-2 grayscale"}`}>
                  <span className={anyUnlocked ? "" : "opacity-50"}>{f.icon}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-2xl font-bold uppercase leading-tight">{f.title}</div>
                  <div className="flex gap-1 pt-1" aria-label={`${done} of 3 tiers claimed`}>
                    {f.tiers.map((t, i) => (
                      <span key={t.id} className={`h-2 flex-1 rounded-full ${t.state === "claimed" ? (i === 2 ? "bg-lime" : i === 1 ? "bg-cream-dim" : "bg-amber") : t.state === "ready" ? "bg-lime/50" : "bg-panel-2"}`} />
                    ))}
                  </div>
                </div>
              </div>

              <ul className="grid gap-2">
                {f.tiers.map((t, i) => {
                  const pct = Math.round((t.progress / t.target) * 100);
                  const style = TIER_STYLE[i];
                  return (
                    <li key={t.id} className={`rounded-lg border p-2.5 ${t.state === "claimed" ? "border-line bg-panel-2/60" : t.state === "ready" ? "border-lime" : style.ring + " border-dashed"}`}>
                      <div className="flex items-center gap-2">
                        <span className={`chip-label w-14 shrink-0 ${style.text}`}>{style.name}</span>
                        <span className="min-w-0 flex-1 text-sm">{t.blurb}</span>
                        {t.state === "claimed" && (
                          <span className={`chip-label text-lime ${burst?.id === t.id ? "pop-in" : ""}`}>✓ <Chips n={t.reward} className="text-cream-dim" /></span>
                        )}
                      </div>
                      {t.state === "ready" && (
                        <button className="btn btn-lime mt-2 w-full py-2" disabled={busy === t.id} onClick={() => claim(t)}>
                          {busy === t.id ? "Claiming…" : <>Claim <Chips n={t.reward} sign className="text-ink" /></>}
                        </button>
                      )}
                      {t.state === "locked" && t === next && (
                        <div className="mt-2 grid gap-1">
                          <div className="h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={t.progress} aria-valuemax={t.target} aria-label={`${t.title} progress`}>
                            <div className="h-full rounded-full bg-teal transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="num flex justify-between text-xs text-cream-faint">
                            <span>{t.progress.toLocaleString()} / {t.target.toLocaleString()}</span>
                            <span className="flex items-center gap-1">🔒 <Chips n={t.reward} /></span>
                          </div>
                        </div>
                      )}
                      {t.state === "locked" && t !== next && (
                        <div className="num mt-1 flex justify-end text-xs text-cream-faint">🔒 <Chips n={t.reward} /></div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {burst?.family === f.id && <Burst reward={burst.reward} />}
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
