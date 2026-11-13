"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";
import { Chips } from "@/components/brand";
import { ErrorNote } from "@/components/ui";

type Kind = "bet" | "draft";

/** Any player can set up a bet they run themselves: no admin, no auto-tracking. */
export function NewManualContest() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("bet");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stake, setStake] = useState(20);
  const [sides, setSides] = useState<string[]>(["", ""]);
  const [rosterSize, setRosterSize] = useState(5);
  const [hidePicks, setHidePicks] = useState(true);
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cleanSides = sides.map((s) => s.trim()).filter(Boolean);
  const ready = title.trim().length >= 3 && (kind === "draft" || cleanSides.length >= 2);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await act<{ id: string }>("create_manual_contest", {
        contest: {
          kind,
          title: title.trim(),
          description: description.trim(),
          stake,
          sides: kind === "bet" ? cleanSides : [],
          roster_size: kind === "draft" ? rosterSize : null,
          pick_visibility: hidePicks ? "after_lock" : "always",
          visibility: isPublic ? "public" : "private",
        },
      });
      router.push(`/c/${r.id}/manage`);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-2xl gap-5">
      <header>
        <h1 className="font-display text-4xl font-extrabold uppercase">Start a bet</h1>
        <p className="text-cream-dim">
          Set it up yourself and run it yourself. You invite people, enter the results, and pay out the winner. Nothing is tracked automatically.
        </p>
      </header>

      <fieldset className="grid gap-2">
        <legend className="label mb-1">What kind?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <KindCard active={kind === "bet"} onClick={() => setKind("bet")} title="Pick a side" body="Everyone picks one side (team A vs team B, over/under, yes/no). You declare the winner." icon="⚖️" />
          <KindCard active={kind === "draft"} onClick={() => setKind("draft")} title="Draft / teams" body="Each player has a roster of players or teams. You type in scores as you go. Highest total wins." icon="📋" />
        </div>
      </fieldset>

      <label className="grid gap-1">
        <span className="label">Name it</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={kind === "bet" ? "Who wins Sunday night?" : "Fantasy golf: Masters weekend"} required />
      </label>

      <label className="grid gap-1">
        <span className="label">Details (optional)</span>
        <textarea className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="How it's decided, any house rules…" />
      </label>

      {kind === "bet" ? (
        <div className="grid gap-2">
          <span className="label">Sides</span>
          {sides.map((s, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input flex-1"
                value={s}
                maxLength={80}
                placeholder={i === 0 ? "e.g. Chiefs" : i === 1 ? "e.g. Bills" : `Side ${i + 1}`}
                onChange={(e) => setSides(sides.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={`Side ${i + 1}`}
              />
              {sides.length > 2 && (
                <button type="button" className="btn btn-ghost px-3" onClick={() => setSides(sides.filter((_, j) => j !== i))} aria-label={`Remove side ${i + 1}`}>✕</button>
              )}
            </div>
          ))}
          {sides.length < 12 && <button type="button" className="link w-fit text-sm" onClick={() => setSides([...sides, ""])}>+ Add another side</button>}
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hidePicks} onChange={(e) => setHidePicks(e.target.checked)} />
            Keep picks hidden until you lock entries
          </label>
        </div>
      ) : (
        <label className="grid gap-1">
          <span className="label">Roster size (players or teams per person)</span>
          <input className="input w-32" type="number" min={1} max={30} value={rosterSize} onChange={(e) => setRosterSize(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
          <span className="text-xs text-cream-dim">You&apos;ll type in everyone&apos;s rosters after they join. Use 1 if each person just has one pick.</span>
        </label>
      )}

      <label className="grid gap-1">
        <span className="label">Entry stake</span>
        <div className="flex flex-wrap items-center gap-2">
          {[0, 10, 20, 50, 100].map((n) => (
            <button key={n} type="button" onClick={() => setStake(n)} className={`rounded-full border px-3 py-1 text-sm font-semibold ${stake === n ? "border-lime text-lime" : "border-line text-cream-dim"}`}>
              {n === 0 ? "Free" : n}
            </button>
          ))}
          <input className="input w-28" type="number" min={0} max={100000} value={stake} onChange={(e) => setStake(Math.max(0, Math.min(100000, Math.floor(Number(e.target.value) || 0))))} aria-label="Custom stake" />
        </div>
        <span className="text-xs text-cream-dim">
          Everyone puts up <Chips n={stake} /> to join. {kind === "bet" ? "Winners split the pot." : "Highest total takes the pot."}
        </span>
      </label>

      <fieldset className="grid gap-2">
        <legend className="label mb-1">Who can see it?</legend>
        <VisibilityChoice isPublic={isPublic} onChange={setIsPublic} />
      </fieldset>

      <ErrorNote error={err} />
      <button className="btn btn-lime py-3 text-lg" disabled={!ready || busy}>{busy ? "Creating…" : "Create & invite people"}</button>
      <p className="text-center text-xs text-cream-faint">Want results tracked automatically from a live feed? <a href="/requests" className="link">Request a contest</a> from an admin instead.</p>
    </form>
  );
}

function KindCard({ active, onClick, title, body, icon }: { active: boolean; onClick: () => void; title: string; body: string; icon: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`card grid gap-1 border-2 p-4 text-left transition ${active ? "border-lime" : "border-line hover:border-cream-faint"}`}>
      <span className="text-2xl">{icon}</span>
      <span className={`font-display text-2xl font-bold uppercase ${active ? "text-lime" : ""}`}>{title}</span>
      <span className="text-sm text-cream-dim">{body}</span>
    </button>
  );
}

/** Private / Public picker, shared by the create form and the manage page. */
export function VisibilityChoice({ isPublic, onChange, disabled = false }: { isPublic: boolean; onChange: (pub: boolean) => void; disabled?: boolean }) {
  const opt = (pub: boolean, icon: string, title: string, body: string) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={isPublic === pub}
      onClick={() => onChange(pub)}
      className={`card grid gap-0.5 border-2 p-3 text-left transition disabled:opacity-60 ${isPublic === pub ? "border-lime" : "border-line hover:border-cream-faint"}`}
    >
      <span className={`font-display text-xl font-bold uppercase ${isPublic === pub ? "text-lime" : ""}`}>{icon} {title}</span>
      <span className="text-xs text-cream-dim">{body}</span>
    </button>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {opt(false, "🔒", "Private", "Only friends you add or people with your link can see and join.")}
      {opt(true, "🌎", "Public", "Listed on Browse once it's open. Anyone signed in can join.")}
    </div>
  );
}
