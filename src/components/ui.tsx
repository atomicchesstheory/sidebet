"use client";

import { useEffect, useState, type ReactNode } from "react";

/** Countdown to a server-provided deadline, corrected by server/client clock skew. */
export function Countdown({ to, serverNow, done = "now", className = "" }: { to: string; serverNow: string; done?: string; className?: string }) {
  const [skew] = useState(() => new Date(serverNow).getTime() - Date.now());
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(t);
  }, [skew]);
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <span className={`num ${className}`}>{done}</span>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return <span className={`num ${className}`}>{d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    setup: ["Setup", "text-cream-dim border-line"],
    open: ["Entries open", "text-lime border-lime/50"],
    drafting: ["On the clock", "text-lime border-lime/50"],
    locked: ["Locked", "text-amber border-amber/50"],
    active: ["Live", "text-teal border-teal/50"],
    awaiting_settlement: ["Awaiting settlement", "text-amber border-amber/50"],
    settled: ["Settled", "text-cream border-cream/40"],
    canceled: ["Canceled", "text-rose border-rose/50"],
    provisional: ["Provisional", "text-sky border-sky/50"],
    final: ["Final", "text-cream border-cream/40"],
    review: ["Awaiting review", "text-amber border-amber/50"],
    in_progress: ["In progress", "text-teal border-teal/50"],
    scheduled: ["Scheduled", "text-cream-dim border-line"],
  };
  const [label, cls] = map[status] ?? [status, "text-cream-dim border-line"];
  return <span className={`chip-label inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${cls}`}>{label}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card border-dashed p-8 text-center">
      <div className="font-display text-2xl font-bold uppercase">{title}</div>
      {children && <div className="mt-2 text-sm text-cream-dim">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-rose/50 bg-rose/10 px-3 py-2 text-sm text-rose">
      {error}
    </div>
  );
}

export { fmtTime, ago, pts, sideText, sideBorder, sideBg } from "@/lib/format";
