"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { act } from "@/lib/client/api";
import { ErrorNote } from "@/components/ui";

type OutcomeRow = { label: string; color: string; kind: "winner" | "attr_true" | "attr_false" | "manual"; value: string };
const COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"];

export function parsePool(text: string) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, seed, aliases] = l.split("|").map((s) => s?.trim());
      return {
        name,
        seed: seed && /^\d+$/.test(seed) ? Number(seed) : null,
        aliases: aliases ? aliases.split(/[;,]/).map((a) => a.trim()).filter(Boolean) : [],
        kind: "player",
      };
    });
}

export function NewContestForm({ request }: { request: { id: string; title: string; body: string } | null }) {
  const router = useRouter();
  const [kind, setKind] = useState<"bet" | "draft">("bet");
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([
    { label: "", color: "teal", kind: "winner", value: "" },
    { label: "", color: "violet", kind: "winner", value: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const lock = s("lock_at");
    const contest = {
      kind,
      title: s("title"),
      description: s("description"),
      category: s("category"),
      visibility: s("visibility"),
      stake: Number(s("stake") || 0),
      max_entrants: s("max_entrants") ? Number(s("max_entrants")) : null,
      lock_at: lock ? new Date(lock).toISOString() : null,
      pick_visibility: s("pick_visibility"),
      terms_text: s("terms_text"),
      request_id: request?.id ?? null,
      ...(kind === "draft"
        ? { roster_size: Number(s("roster_size")), draft_format: s("draft_format"), draft_mode: s("draft_mode") }
        : { resolution: { ...(s("event_key") ? { event_key: s("event_key") } : {}), ...(s("event_label") ? { label: s("event_label") } : {}) } }),
    };
    const outs =
      kind === "bet"
        ? outcomes
            .filter((o) => o.label.trim())
            .map((o) => ({
              label: o.label.trim(),
              color: o.color,
              resolve_when:
                o.kind === "winner" && o.value.trim()
                  ? [{ fact: "event.winner", op: "eq", value: o.value.trim() }]
                  : o.kind === "attr_true" && o.value.trim()
                    ? [{ fact: `event.${o.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`, op: "true" }]
                    : o.kind === "attr_false" && o.value.trim()
                      ? [{ fact: `event.${o.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`, op: "false" }]
                      : [],
            }))
        : [];
    setBusy(true);
    setErr(null);
    try {
      const r = await act<{ id: string }>("create_contest", { contest, outcomes: outs, pool: kind === "draft" ? parsePool(s("pool")) : [] });
      router.push(`/admin/c/${r.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      {request && (
        <div className="card border-lime/40 p-4 text-sm">
          <div className="chip-label text-lime">From request</div>
          <div className="font-semibold">{request.title}</div>
          <p className="whitespace-pre-wrap text-cream-dim">{request.body}</p>
        </div>
      )}
      <div className="flex gap-2" role="radiogroup" aria-label="Contest type">
        {(["bet", "draft"] as const).map((k) => (
          <button type="button" key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`btn flex-1 ${kind === k ? "btn-lime" : "btn-ghost"}`}>
            {k === "bet" ? "Normal bet" : "Draft contest"}
          </button>
        ))}
      </div>
      <div className="card grid gap-4 p-4 md:grid-cols-2">
        <label className="md:col-span-2"><span className="label">Title</span><input name="title" className="input" required minLength={3} maxLength={120} defaultValue={request?.title ?? ""} /></label>
        <label className="md:col-span-2"><span className="label">Description</span><textarea name="description" className="input" maxLength={2000} defaultValue={request?.body ?? ""} /></label>
        <label><span className="label">Category</span><select name="category" className="input" defaultValue={kind === "draft" ? "chess" : "sports"}><option value="chess">Chess</option><option value="sports">Sports</option><option value="custom">Custom</option></select></label>
        <label><span className="label">Visibility</span><select name="visibility" className="input" defaultValue="private"><option value="private">Private (invite only)</option><option value="public">Public (browse & join)</option></select></label>
        <label><span className="label">Entry stake (chips)</span><input name="stake" type="number" min={0} max={100000} defaultValue={20} className="input" required /></label>
        <label><span className="label">Max entrants (optional)</span><input name="max_entrants" type="number" min={2} max={64} className="input" defaultValue={kind === "draft" ? 2 : ""} /></label>
        <label><span className="label">Entries lock at (optional)</span><input name="lock_at" type="datetime-local" className="input" /></label>
        <label><span className="label">Show picks</span><select name="pick_visibility" className="input" defaultValue="after_lock"><option value="after_lock">After entries lock</option><option value="always">Right away</option></select></label>
        <label className="md:col-span-2"><span className="label">House rules shown to entrants (optional)</span><textarea name="terms_text" className="input" maxLength={2000} /></label>
      </div>

      {kind === "bet" ? (
        <div className="card grid gap-3 p-4">
          <div className="font-display text-xl font-bold uppercase">Outcomes</div>
          <p className="text-sm text-cream-dim">Each outcome can resolve automatically from verified results, or you choose it at settlement.</p>
          {outcomes.map((o, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-[1.2fr_0.6fr_1fr_1fr_auto]">
              <input className="input" placeholder={`Outcome ${i + 1} (e.g. Comets win)`} value={o.label} onChange={(e) => setOutcomes(outcomes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Outcome label" />
              <select className="input" value={o.color} onChange={(e) => setOutcomes(outcomes.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} aria-label="Color">
                {COLORS.map((c) => <option key={c}>{c}</option>)}
              </select>
              <select className="input" value={o.kind} onChange={(e) => setOutcomes(outcomes.map((x, j) => (j === i ? { ...x, kind: e.target.value as OutcomeRow["kind"] } : x)))} aria-label="Resolves when">
                <option value="winner">Resolves when winner is…</option>
                <option value="attr_true">Resolves when fact is true…</option>
                <option value="attr_false">Resolves when fact is false…</option>
                <option value="manual">Admin decides</option>
              </select>
              <input className="input" disabled={o.kind === "manual"} placeholder={o.kind === "winner" ? "Harbor City Comets" : "overtime"} value={o.value} onChange={(e) => setOutcomes(outcomes.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Resolution value" />
              <button type="button" className="btn btn-ghost px-2" disabled={outcomes.length <= 2} onClick={() => setOutcomes(outcomes.filter((_, j) => j !== i))} aria-label="Remove outcome">✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost w-fit" onClick={() => setOutcomes([...outcomes, { label: "", color: COLORS[outcomes.length % 6], kind: "winner", value: "" }])}>+ Add outcome</button>
          <div className="grid gap-3 md:grid-cols-2">
            <label><span className="label">Tracked event key (optional — e.g. espn:401234)</span><input name="event_key" className="input" /></label>
            <label><span className="label">Tracked event label</span><input name="event_label" className="input" placeholder="Comets vs Owls" /></label>
          </div>
        </div>
      ) : (
        <div className="card grid gap-4 p-4 md:grid-cols-3">
          <label><span className="label">Roster size</span><input name="roster_size" type="number" min={1} max={30} defaultValue={4} className="input" required /></label>
          <label><span className="label">Format</span><select name="draft_format" className="input"><option value="snake">Snake</option><option value="straight">Straight</option></select></label>
          <label><span className="label">Draft</span><select name="draft_mode" className="input"><option value="offline">Already drafted offline (import)</option><option value="live">Live draft in the app</option></select></label>
          <label className="md:col-span-3">
            <span className="label">Available picks — one per line: <code>Name | seed | alias; alias</code></span>
            <textarea name="pool" className="input min-h-48 font-mono text-sm" placeholder={"Mira Okafor | 1 | M. Okafor\nLev Dragunov | 2\nKofi Mensah"} />
          </label>
          <p className="text-sm text-cream-dim md:col-span-3">Next you&apos;ll write scoring rules in plain English and approve them before entries open. Payout: winner takes all; ties after tiebreakers split.</p>
        </div>
      )}
      <ErrorNote error={err} />
      <button className="btn btn-lime py-3 text-lg" disabled={busy}>{busy ? "Creating…" : "Create contest (setup)"}</button>
    </form>
  );
}
