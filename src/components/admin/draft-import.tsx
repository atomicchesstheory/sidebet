"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ContestView } from "@/lib/server/contests";
import { act } from "@/lib/client/api";
import { ErrorNote, sideBorder, sideText } from "@/components/ui";

const SEAT_COLORS = ["teal", "violet", "amber", "sky", "rose", "lime"];

/** Enter rosters drafted outside the app, review both side by side, then lock them in. */
export function DraftImport({ view }: { view: ContestView }) {
  const router = useRouter();
  const c = view.contest;
  const pool = useMemo(() => view.draft?.pool ?? [], [view.draft]);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.entrants.map((e) => [e.entry_id, view.rosters.find((r) => r.entry_id === e.entry_id)?.picks.map((p) => p.name).join("\n") ?? ""])),
  );
  const [step, setStep] = useState<"enter" | "review">("enter");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rosters = useMemo(
    () =>
      view.entrants.map((e) => {
        const names = (texts[e.entry_id] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        return {
          entry: e,
          picks: names.map((n) => {
            const hit = pool.find((p) => p.name.toLowerCase() === n.toLowerCase() || p.aliases.some((a) => a.toLowerCase() === n.toLowerCase()));
            return { input: n, name: hit?.name ?? n, seed: hit?.seed ?? null, known: !!hit };
          }),
        };
      }),
    [texts, view.entrants, pool],
  );
  const all = rosters.flatMap((r) => r.picks.map((p) => p.name.toLowerCase()));
  const dupes = new Set(all.filter((n, i) => all.indexOf(n) !== i));
  const tooBig = rosters.filter((r) => r.picks.length > (c.roster_size ?? 0));
  const short = rosters.filter((r) => r.picks.length < (c.roster_size ?? 0));
  const problems = [
    ...[...dupes].map((d) => `“${d}” is on more than one roster.`),
    ...tooBig.map((r) => `${r.entry.display_name} has ${r.picks.length} picks (roster size ${c.roster_size}).`),
  ];

  return (
    <div className="grid gap-5">
      <Link href={`/admin/c/${c.id}`} className="text-sm text-cream-dim hover:text-cream">← Manage {c.title}</Link>
      <h1 className="font-display text-4xl font-extrabold uppercase leading-none">Import offline draft</h1>
      <p className="max-w-2xl text-cream-dim">
        Enter the picks you already made, one per line in draft order. Names are matched to the pick list ({pool.length} picks); anything new is added.
        Review both rosters before scoring starts — once results are scored, rosters are final.
      </p>
      <datalist id="pool-names">{pool.map((p) => <option key={p.id} value={p.name} />)}</datalist>

      {step === "enter" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {view.entrants.map((e) => (
            <label key={e.entry_id} className={`card grid gap-2 border-t-4 p-4 ${sideBorder[SEAT_COLORS[(e.seat - 1) % 6]]}`}>
              <span className={`font-display text-2xl font-bold uppercase ${sideText[SEAT_COLORS[(e.seat - 1) % 6]]}`}>{e.display_name}</span>
              <textarea
                className="input min-h-48 font-mono text-sm"
                value={texts[e.entry_id]}
                onChange={(ev) => setTexts({ ...texts, [e.entry_id]: ev.target.value })}
                placeholder={pool.slice(0, c.roster_size ?? 4).map((p) => p.name).join("\n")}
                aria-label={`${e.display_name} roster`}
              />
              <span className="num text-xs text-cream-dim">{rosters.find((r) => r.entry.entry_id === e.entry_id)?.picks.length ?? 0} / {c.roster_size} picks</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rosters.map((r) => (
            <div key={r.entry.entry_id} className={`card border-t-4 p-4 ${sideBorder[SEAT_COLORS[(r.entry.seat - 1) % 6]]}`}>
              <div className={`font-display text-2xl font-bold uppercase ${sideText[SEAT_COLORS[(r.entry.seat - 1) % 6]]}`}>{r.entry.display_name}</div>
              <ol className="mt-2 grid gap-1 text-sm">
                {r.picks.map((p, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="num w-6 text-xs text-cream-faint">{i + 1}</span>
                    <span className="flex-1 font-semibold">{p.name}</span>
                    {p.seed && <span className="text-[10px] font-bold text-cream-dim">SEED {p.seed}</span>}
                    {!p.known && <span className="chip-label text-amber">new pick</span>}
                    {p.known && p.input !== p.name && <span className="text-xs text-cream-faint">from “{p.input}”</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {problems.length > 0 && <ErrorNote error={problems.join(" ")} />}
      {short.length > 0 && problems.length === 0 && <p className="text-sm text-amber">{short.map((r) => `${r.entry.display_name} has ${r.picks.length} of ${c.roster_size} picks.`).join(" ")} You can import partial rosters.</p>}
      <ErrorNote error={err} />
      <div className="flex gap-2">
        {step === "enter" ? (
          <button className="btn btn-lime" disabled={problems.length > 0 || rosters.every((r) => r.picks.length === 0)} onClick={() => setStep("review")}>Review rosters</button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => setStep("enter")}>Back</button>
            <button
              className="btn btn-lime"
              disabled={busy || problems.length > 0}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await act("import_draft", { contest_id: c.id, rosters: rosters.map((r) => ({ entry_id: r.entry.entry_id, picks: r.picks.map((p) => p.name) })) });
                  router.push(`/c/${c.id}`);
                } catch (e) {
                  setErr((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              {busy ? "Importing…" : "Lock in rosters & start scoring"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
