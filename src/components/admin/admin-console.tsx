"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { useCallback, useState } from "react";
import type { ContestView } from "@/lib/server/contests";
import type { PipelineResult } from "@/lib/server/results/pipeline";
import { act, getJson } from "@/lib/client/api";
import { describeRuleset } from "@/lib/describe";
import { RulesetSchema, type Ruleset } from "@/lib/scoring/schema";
import { Chips } from "@/components/brand";
import { ErrorNote, StatusPill, ago, fmtTime, pts } from "@/components/ui";
import { parsePool } from "./new-contest-form";

type AdminData = { view: ContestView; admin: { invites: any[]; sources: any[]; rulesets: any[]; reviews: any[]; revisions: any[]; fixtures: string[]; demo: boolean } };
type Tab = "setup" | "scoring" | "results" | "review" | "settle";

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr((e as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, err, run, setErr };
}

export function AdminConsole({ initial, initialTab }: { initial: AdminData; initialTab: Tab }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Tab>(initialTab);
  const id = initial.view.contest.id;
  const reload = useCallback(async () => setData(await getJson<AdminData>(`/api/admin/contests/${id}`)), [id]);
  const c = data.view.contest;
  const openReviews = data.admin.reviews.filter((r) => r.status === "open").length;
  const tabs: [Tab, string][] = [
    ["setup", "Setup"],
    ["scoring", c.kind === "draft" ? "Scoring rules" : "Outcomes"],
    ["results", "Results"],
    ["review", `Review${openReviews ? ` (${openReviews})` : ""}`],
    ["settle", "Settle"],
  ];
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/admin" className="text-sm text-cream-dim hover:text-cream">← Admin</Link>
        <StatusPill status={c.status} />
        {c.result_status !== "none" && <StatusPill status={c.result_status} />}
        <Link href={`/c/${id}`} className="btn btn-ghost ml-auto px-3 py-1.5 text-sm">View contest page</Link>
      </div>
      <h1 className="font-display text-4xl font-extrabold uppercase leading-none">{c.title}</h1>
      <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-bold ${tab === t ? "border-lime text-lime" : "border-transparent text-cream-dim"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "setup" && <SetupTab data={data} reload={reload} />}
      {tab === "scoring" &&
        (c.kind === "draft" ? (
          // keyed by the current draft proposal so a new proposal resets the editor
          <ScoringTab key={data.admin.rulesets.find((r) => r.status === "draft")?.id ?? "none"} data={data} reload={reload} />
        ) : (
          <OutcomesTab data={data} />
        ))}
      {tab === "results" && <ResultsTab data={data} reload={reload} />}
      {tab === "review" && <ReviewTab data={data} reload={reload} />}
      {tab === "settle" && <SettleTab data={data} reload={reload} />}
    </div>
  );
}

// ------------------------------------------------------------------ setup --
function SetupTab({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { view, admin } = data;
  const c = view.contest;
  const { busy, err, run } = useAction();
  const [reason, setReason] = useState("");
  const [inviteLabel, setInviteLabel] = useState("");
  const [poolText, setPoolText] = useState(() => (view.draft?.pool ?? []).map((p) => [p.name, p.seed ?? "", p.aliases.join("; ")].filter((x, i) => i === 0 || x !== "").join(" | ")).join("\n"));
  const setStatus = (status: string) => run(status, async () => { await act("set_status", { contest_id: c.id, status }); await reload(); });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const hasApproved = !!admin.rulesets.find((r) => r.status === "approved");

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card grid content-start gap-3 p-4">
        <h2 className="font-display text-xl font-bold uppercase">Status</h2>
        <div className="flex flex-wrap gap-2">
          {c.status === "setup" && (
            <button className="btn btn-lime" disabled={!!busy || (c.kind === "draft" && !hasApproved) || (c.kind === "bet" && view.outcomes.length < 2)} onClick={() => setStatus("open")}>Open entries</button>
          )}
          {c.status === "setup" && c.kind === "draft" && !hasApproved && <span className="text-sm text-amber">Approve scoring rules first.</span>}
          {c.status === "open" && !c.terms_locked_at && <button className="btn btn-ghost" onClick={() => setStatus("setup")}>Back to setup</button>}
          {c.status === "open" && c.kind === "bet" && <button className="btn btn-ghost" onClick={() => setStatus("locked")}>Lock entries now</button>}
          {c.status === "open" && c.kind === "draft" && c.draft_mode === "live" && (
            <button className="btn btn-lime" disabled={view.entrants.length < 2 || !!busy} onClick={() => run("draft", async () => { await act("start_draft", { contest_id: c.id }); await reload(); })}>Start live draft</button>
          )}
          {c.kind === "draft" && ["open", "drafting", "active"].includes(c.status) && view.events.length === 0 && (
            <Link className="btn btn-ghost" href={`/admin/c/${c.id}/import`}>Import offline draft</Link>
          )}
          {c.status === "drafting" && <Link className="btn btn-lime" href={`/c/${c.id}/draft`}>Open draft board</Link>}
          {["locked", "active"].includes(c.status) && <button className="btn btn-ghost" onClick={() => setStatus("awaiting_settlement")}>Results are in → settlement</button>}
          {c.status === "locked" && <button className="btn btn-ghost" onClick={() => setStatus("active")}>Mark active</button>}
          {c.status === "awaiting_settlement" && <button className="btn btn-ghost" onClick={() => setStatus("active")}>Reopen (not final)</button>}
        </div>
        <div className="text-sm text-cream-dim">
          {view.entrants.length} entrants · pot <Chips n={view.pot} /> · {c.terms_locked_at ? `terms locked ${fmtTime(c.terms_locked_at)}` : "terms editable until the first entry"}
        </div>
        {!["settled", "canceled"].includes(c.status) && (
          <div className="mt-2 grid gap-2 rounded-lg border border-rose/30 p-3">
            <div className="chip-label text-rose">Cancel contest</div>
            <p className="text-xs text-cream-dim">Refunds every stake in full. Can&apos;t be undone.</p>
            <input className="input" placeholder="Reason (shown to entrants)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-danger w-fit" disabled={!!busy} onClick={() => confirm("Cancel and refund every stake?") && run("cancel", async () => { await act("cancel", { contest_id: c.id, reason }); await reload(); })}>
              Cancel & refund
            </button>
          </div>
        )}
        <ErrorNote error={err} />
      </section>

      <section className="card grid content-start gap-3 p-4">
        <h2 className="font-display text-xl font-bold uppercase">Invite links</h2>
        {c.visibility === "public" && <p className="text-sm text-cream-dim">Public contest — anyone signed in can find it in Browse. Invite links still work.</p>}
        <div className="flex gap-2">
          <input className="input" placeholder="Label (e.g. Family)" value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)} />
          <button className="btn btn-lime" disabled={!!busy} onClick={() => run("inv", async () => { await act("create_invite", { contest_id: c.id, label: inviteLabel }); setInviteLabel(""); await reload(); })}>Create</button>
        </div>
        <ul className="grid gap-2 text-sm">
          {admin.invites.map((i) => (
            <li key={i.id} className={`rounded-lg border border-line p-2 ${i.revoked_at ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{i.label}</span>
                <span className="num text-xs text-cream-faint">{i.uses} used</span>
                {i.revoked_at ? <span className="chip-label ml-auto text-rose">Revoked</span> : (
                  <button className="btn btn-danger ml-auto px-2 py-1 text-xs" onClick={() => run("rev", async () => { await act("revoke_invite", { invite_id: i.id }); await reload(); })}>Revoke</button>
                )}
              </div>
              {!i.revoked_at && <input readOnly className="input mt-1 font-mono text-xs" value={`${origin}/invite/${i.token}`} onFocus={(e) => e.currentTarget.select()} aria-label="Invite URL" />}
            </li>
          ))}
          {admin.invites.length === 0 && <li className="text-cream-dim">No invite links yet.</li>}
        </ul>
      </section>

      {c.kind === "draft" && (
        <section className="card grid content-start gap-3 p-4 md:col-span-2">
          <h2 className="font-display text-xl font-bold uppercase">Available picks</h2>
          <p className="text-sm text-cream-dim">One per line: <code>Name | seed | alias; alias</code>. Aliases help match result sources (e.g. “M. Okafor”). Drafted picks can&apos;t be removed.</p>
          <textarea className="input min-h-48 font-mono text-sm" value={poolText} onChange={(e) => setPoolText(e.target.value)} aria-label="Pool" />
          <button className="btn btn-ghost w-fit" disabled={!!busy} onClick={() => run("pool", async () => { await act("save_pool", { contest_id: c.id, pool: parsePool(poolText), remove_missing: true }); await reload(); })}>Save picks</button>
        </section>
      )}
    </div>
  );
}

// ----------------------------------------------------------- bet outcomes --
function OutcomesTab({ data }: { data: AdminData }) {
  const { view } = data;
  return (
    <section className="card grid gap-3 p-4">
      <h2 className="font-display text-xl font-bold uppercase">Outcomes & resolution</h2>
      <p className="text-sm text-cream-dim">Tracked event: {view.contest.resolution?.label || view.contest.resolution?.event_key || "first event from the source"}. Outcomes are locked with the terms once someone enters.</p>
      <ul className="grid gap-2">
        {view.outcomes.map((o) => (
          <li key={o.id} className="rounded-lg border border-line p-3 text-sm">
            <div className="font-semibold">{o.label}</div>
            <div className="text-xs text-cream-dim">
              {(o.resolve_when as any[]).length ? `Resolves when ${(o.resolve_when as any[]).map((cc) => `${cc.fact} ${cc.op}${cc.value !== undefined ? ` ${JSON.stringify(cc.value)}` : ""}`).join(" and ")}` : "Admin decides at settlement"}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- scoring --
const OPTION_CHOICES: Record<string, [string, string][]> = {
  unseeded: [["lowest", "Unseeded ranks below every seed"], ["no_bonus", "No seed bonus involving unseeded players"]],
  forfeits: [["count", "Forfeits count like normal results"], ["ignore", "Ignore forfeits"]],
  final_only: [["true", "Only final results score"], ["false", "Score provisional results too"]],
};

function ScoringTab({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { view, admin } = data;
  const c = view.contest;
  const approved = admin.rulesets.find((r) => r.status === "approved");
  const draft = admin.rulesets.find((r) => r.status === "draft");
  const [instructions, setInstructions] = useState<string>(draft?.instructions ?? approved?.instructions ?? "");
  const { busy, err, run, setErr } = useAction();
  const [rulesText, setRulesText] = useState(draft ? JSON.stringify(draft.rules, null, 2) : "");
  const [answers, setAnswers] = useState<Record<string, string>>(draft?.answers ?? {});
  const [examples, setExamples] = useState<any[] | null>(null);
  const [aiErrors, setAiErrors] = useState<string[] | null>(null);
  const locked = !!c.terms_locked_at;

  let parsed: Ruleset | null = null;
  let parseErr: string | null = null;
  try {
    const r = RulesetSchema.safeParse(JSON.parse(rulesText || "null"));
    if (r.success) parsed = r.data;
    else parseErr = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  } catch {
    parseErr = rulesText ? "Rules aren't valid JSON." : null;
  }

  const setOption = (key: string, value: string) => {
    if (!parsed) return;
    const next = { ...parsed, options: { ...parsed.options, [key]: key === "final_only" ? value === "true" : value } };
    setRulesText(JSON.stringify(next, null, 2));
  };

  return (
    <div className="grid gap-4">
      {approved && (
        <section className="card grid gap-2 border-lime/40 p-4">
          <div className="flex items-center gap-2"><h2 className="font-display text-xl font-bold uppercase">Approved rules (v{approved.version})</h2><span className="chip-label text-lime">Live</span></div>
          <blockquote className="border-l-2 border-lime pl-3 text-sm">{approved.instructions}</blockquote>
          <ul className="list-disc pl-5 text-sm text-cream-dim">{describeRuleset(approved.rules).map((l) => <li key={l}>{l}</li>)}</ul>
          {locked && <p className="text-xs text-cream-faint">🔒 Terms locked — rules can&apos;t change after the first entry. Use explicit adjustments (Results tab) with a reason.</p>}
        </section>
      )}
      {!locked && (
        <section className="card grid gap-3 p-4">
          <h2 className="font-display text-xl font-bold uppercase">Write how you score it</h2>
          <textarea className="input min-h-28" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Each drafted player gets 2 points for a match win and 3 extra if they beat a higher seed. Only main-bracket matches count." aria-label="Scoring instructions" />
          <button
            className="btn btn-lime w-fit"
            disabled={!!busy || instructions.trim().length < 5}
            onClick={() =>
              run("propose", async () => {
                const r = await act<any>("propose_rules", { contest_id: c.id, instructions });
                if (!r.ok) setAiErrors(r.errors);
                else setAiErrors(null);
                await reload();
              })
            }
          >
            {busy === "propose" ? "Reading your rules…" : "Turn into rules"}
          </button>
          {aiErrors && <ErrorNote error={`The proposal didn't validate: ${aiErrors.join("; ")}`} />}
        </section>
      )}

      {draft && !locked && (
        <section className="card grid gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-bold uppercase">Proposal v{draft.version}</h2>
            <span className="chip-label text-cream-faint">by {draft.proposed_by}</span>
          </div>
          <blockquote className="border-l-2 border-cream-faint pl-3 text-sm text-cream-dim">“{draft.instructions}”</blockquote>

          {(draft.questions as any[]).length > 0 && (
            <div className="grid gap-3">
              <div className="chip-label text-amber">Questions that affect scoring</div>
              {(draft.questions as any[]).map((q) => (
                <div key={q.id} className="rounded-lg border border-amber/30 p-3 text-sm">
                  <div className="font-semibold">{q.question}</div>
                  {q.why && <div className="text-xs text-cream-dim">{q.why}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(q.option_key ? OPTION_CHOICES[q.option_key] : (q.options as string[]).map((o): [string, string] => [o, o])).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={`btn px-3 py-1 text-xs ${answers[q.id] === label || answers[q.id] === val ? "btn-lime" : "btn-ghost"}`}
                        onClick={() => {
                          setAnswers({ ...answers, [q.id]: label });
                          if (q.option_key) setOption(q.option_key, val);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!q.option_key && (
                    <input className="input mt-2 text-sm" placeholder="Or type an answer" value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
          )}

          {(draft.unsupported as any[]).length > 0 && (
            <div className="grid gap-2 rounded-lg border border-rose/40 p-3 text-sm">
              <div className="chip-label text-rose">Can&apos;t be represented as rules</div>
              <ul className="grid gap-1">{(draft.unsupported as any[]).map((u) => <li key={u.text}><span className="font-semibold">“{u.text}”</span> <span className="text-cream-dim">— {u.reason}</span></li>)}</ul>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={answers.__unsupported_ack === "yes"} onChange={(e) => setAnswers({ ...answers, __unsupported_ack: e.target.checked ? "yes" : "" })} />
                I&apos;ll apply these with explicit admin adjustments (each shows its reason in the breakdown).
              </label>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid content-start gap-2">
              <div className="chip-label text-cream-faint">Structured rules (editable)</div>
              <textarea className="input min-h-72 font-mono text-xs" value={rulesText} onChange={(e) => setRulesText(e.target.value)} aria-label="Rules JSON" spellCheck={false} />
              {parseErr && <ErrorNote error={parseErr} />}
            </div>
            <div className="grid content-start gap-2">
              <div className="chip-label text-cream-faint">In plain English</div>
              {parsed ? <ul className="list-disc pl-5 text-sm">{describeRuleset(parsed).map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-sm text-cream-dim">Fix the rules to see them here.</p>}
              <button className="btn btn-ghost w-fit" disabled={!parsed || !!busy} onClick={() => run("preview", async () => { const r = await act<any>("preview_rules", { contest_id: c.id, rules: parsed }); if (r.ok) setExamples(r.examples); else setErr(r.errors.join("; ")); })}>
                Preview example results
              </button>
              {examples && (
                <div className="grid gap-2">
                  {examples.map((ex) => (
                    <div key={ex.title} className="rounded-lg bg-shell p-3 text-sm">
                      <div className="font-semibold">{ex.title} <span className="text-xs text-cream-faint">{ex.facts.label}{ex.facts.bracket ? ` · ${ex.facts.bracket}` : ""}{ex.facts.is_forfeit ? " · forfeit" : ""}</span></div>
                      {ex.note && <div className="text-xs text-amber">{ex.note}</div>}
                      {ex.results.map((r: any) => (
                        <div key={r.name} className="flex justify-between gap-2">
                          <span className="text-cream-dim">{r.name}</span>
                          <span className="num"><b>{pts(r.total)} pts</b>{r.lines.length > 0 && <span className="text-xs text-cream-dim"> ({r.lines.map((l: any) => `${l.label} +${pts(l.points)}`).join(", ")})</span>}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <ErrorNote error={err} />
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={!parsed || !!busy} onClick={() => run("save", async () => { await act("save_rules", { ruleset_id: draft.id, rules: parsed, answers }); await reload(); })}>Save draft</button>
            <button
              className="btn btn-lime"
              disabled={!parsed || !!busy}
              onClick={() => run("approve", async () => { await act("save_rules", { ruleset_id: draft.id, rules: parsed, answers }); await act("approve_rules", { ruleset_id: draft.id }); await reload(); })}
            >
              Approve rules
            </button>
          </div>
          <p className="text-xs text-cream-faint">Your original words are saved with the approved rules. Application code — not the AI — applies them to verified results.</p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- results --
function PlanView({ plan }: { plan: PipelineResult | { error: string } | null }) {
  if (!plan) return null;
  if ("error" in plan) return <ErrorNote error={plan.error} />;
  return (
    <div className="grid gap-2 text-sm">
      <div className="num text-xs text-cream-dim">{Object.entries(plan.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(" · ") || "nothing to do"}</div>
      {plan.items.map((it) => (
        <div key={it.event_key} className="rounded-lg bg-shell p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{it.label}</span>
            <StatusPill status={it.status} />
            <span className={`chip-label ${it.action === "review" ? "text-amber" : it.action === "correction" ? "text-rose" : it.action === "unchanged" || it.action === "skipped" ? "text-cream-faint" : "text-lime"}`}>{it.action}</span>
          </div>
          {it.reason && <div className="text-xs text-cream-dim">{it.reason}</div>}
          {it.matched.length > 0 && <div className="text-xs text-cream-faint">{it.matched.map((m) => `${m.name}: ${m.status}`).join(" · ")}</div>}
          {it.lines.map((l, i) => <div key={i} className="text-xs">{l.pick_name}: {l.label} <b className="text-lime">+{pts(l.points)}</b></div>)}
          {it.deltas.map((d) => <div key={d.pool_item_id} className="text-xs text-cream-dim">{d.name}: {pts(d.before)} → <b>{pts(d.after)}</b></div>)}
          {it.outcome && <div className="text-xs">Outcome: <b>{it.outcome.label ?? "pending"}</b></div>}
        </div>
      ))}
    </div>
  );
}

function ResultsTab({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { view, admin } = data;
  const c = view.contest;
  const { busy, err, run } = useAction();
  const [checkOut, setCheckOut] = useState<any[] | null>(null);
  const [preview, setPreview] = useState<Record<string, any>>({});
  const [kind, setKind] = useState("pgn");
  const [manualText, setManualText] = useState("");
  const [manual, setManual] = useState<any>(null);
  const [adj, setAdj] = useState({ target: "", points: "", reason: "" });

  return (
    <div className="grid gap-4">
      <section className="card grid gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-xl font-bold uppercase">Sources</h2>
          <span className="text-xs text-cream-dim">Last good check {ago(c.last_success_at)}{c.last_error ? ` · last error: ${c.last_error}` : ""}</span>
          <button className="btn btn-lime ml-auto" disabled={!!busy} onClick={() => run("check", async () => { setCheckOut(await act<any[]>("check_now", { contest_id: c.id })); await reload(); })}>
            {busy === "check" ? "Checking…" : "Check results now"}
          </button>
        </div>
        {checkOut && (
          <div className="grid gap-1 rounded-lg bg-shell p-2 text-xs">
            {checkOut.length === 0 && <div>No automatic sources attached.</div>}
            {checkOut.map((o) => <div key={o.source_id} className={o.ok ? "" : "text-rose"}>{o.label}: {o.ok ? `${o.notes} — ${Object.entries(o.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "no changes"}` : o.error}</div>)}
          </div>
        )}
        <ul className="grid gap-2">
          {admin.sources.map((s) => (
            <li key={s.id} className="rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.label}</span>
                <span className="chip-label text-cream-faint">{s.kind}{s.kind === "fixture" ? " · demo" : ""}</span>
                {!s.enabled && <span className="chip-label text-rose">Paused</span>}
                <div className="ml-auto flex gap-1">
                  {s.kind !== "manual" && <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!!busy} onClick={() => run("pv" + s.id, async () => { setPreview({ ...preview, [s.id]: await act("preview_source", { source_id: s.id }) }); })}>Preview</button>}
                  {s.kind === "fixture" && (
                    <>
                      <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => run("adv", async () => { await act("advance_fixture", { source_id: s.id, delta: -1 }); await reload(); })}>◀ Stage</button>
                      <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => run("adv", async () => { await act("advance_fixture", { source_id: s.id, delta: 1 }); await reload(); })}>Stage ▶</button>
                    </>
                  )}
                  <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => run("tog", async () => { await act("update_source", { source_id: s.id, enabled: !s.enabled }); await reload(); })}>{s.enabled ? "Pause" : "Resume"}</button>
                  <button className="btn btn-danger px-2 py-1 text-xs" onClick={() => confirm("Remove this source? Scores stay.") && run("del", async () => { await act("delete_source", { source_id: s.id }); await reload(); })}>Remove</button>
                </div>
              </div>
              {s.url && <div className="truncate text-xs text-cream-dim">{s.url}</div>}
              {s.kind === "fixture" && <div className="text-xs text-cream-dim">Fixture “{s.config.fixture}” · stage {(s.config.stage ?? 0) + 1}. Advance the stage, then Check results now (or wait for the scheduler).</div>}
              <div className="text-xs text-cream-faint">Last attempt {ago(s.last_attempt_at)} · last success {ago(s.last_success_at)}</div>
              {s.last_error && <div className="text-xs text-rose">Error: {s.last_error}</div>}
              {preview[s.id] && (
                <div className="mt-2 grid gap-2 rounded-lg border border-line p-2">
                  <div className="text-xs text-cream-dim">{preview[s.id].read.notes} · {preview[s.id].read.events.length} events read{preview[s.id].read.rejected.length ? ` · ${preview[s.id].read.rejected.length} rejected` : ""}</div>
                  <details><summary className="text-xs text-lime">What the app read</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-cream-dim">{preview[s.id].read.preview}</pre></details>
                  <div className="chip-label text-cream-faint">Dry run (nothing saved)</div>
                  <PlanView plan={preview[s.id].plan} />
                </div>
              )}
            </li>
          ))}
          {admin.sources.length === 0 && <li className="text-sm text-cream-dim">No sources yet. Attach a results page or feed, or enter results manually below.</li>}
        </ul>
        <form
          className="grid gap-2 rounded-lg border border-dashed border-line p-3 md:grid-cols-[0.8fr_1.5fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const cfg: Record<string, string> = {};
            for (const k of ["fixture", "bracket", "event_id", "team"]) if (f.get(k)) cfg[k] = String(f.get(k));
            const form = e.currentTarget;
            run("add", async () => {
              await act("add_source", { contest_id: c.id, source: { kind, url: f.get("url") || null, label: f.get("label") || "Results source", config: { ...cfg, ...(kind === "fixture" ? { stage: 0 } : {}) } } });
              form.reset();
              await reload();
            });
          }}
        >
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Source type">
            <option value="pgn">PGN feed (chess)</option>
            <option value="espn">ESPN scoreboard JSON</option>
            <option value="sidebet_json">Side Bet JSON feed</option>
            <option value="manual">Manual / admin-entered</option>
            {admin.demo && <option value="fixture">Demo fixture</option>}
          </select>
          {kind === "fixture" ? (
            <select name="fixture" className="input" aria-label="Fixture">{admin.fixtures.map((f) => <option key={f}>{f}</option>)}</select>
          ) : kind === "manual" ? (
            <span className="self-center text-xs text-cream-dim">Enter results below.</span>
          ) : (
            <input name="url" className="input" type="url" placeholder="https://…" required aria-label="URL" />
          )}
          <input name="label" className="input" placeholder="Label" aria-label="Label" />
          <button className="btn btn-ghost">Attach</button>
          {kind === "pgn" && <input name="bracket" className="input md:col-span-2" placeholder="Bracket name for these games (default: main)" />}
          {kind === "espn" && <><input name="event_id" className="input" placeholder="ESPN event id (optional)" /><input name="team" className="input" placeholder="Team filter (optional)" /></>}
        </form>
      </section>

      <section className="card grid gap-3 p-4">
        <h2 className="font-display text-xl font-bold uppercase">Enter a result</h2>
        <p className="text-sm text-cream-dim">For events without a public source. Write it plainly — e.g. “Josiah won race two” or “Okafor beat Lindqvist 2-1 in round 3”. You&apos;ll see what was understood and the exact points before anything changes.</p>
        <textarea className="input min-h-20" value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="Josiah won race two" aria-label="Result text" />
        <button className="btn btn-ghost w-fit" disabled={!manualText.trim() || !!busy} onClick={() => run("mp", async () => setManual(await act("manual_preview", { contest_id: c.id, text: manualText })))}>
          {busy === "mp" ? "Reading…" : "Preview"}
        </button>
        {manual && (
          <div className="grid gap-2 rounded-lg border border-line p-3">
            <div className="text-xs text-cream-dim">{manual.provider}: {manual.notes}</div>
            {manual.events.length === 0 ? (
              <ErrorNote error="Nothing understood. Rephrase it, or be more specific." />
            ) : (
              <>
                <div className="chip-label text-cream-faint">What was understood</div>
                <pre className="max-h-48 overflow-auto rounded bg-shell p-2 text-[11px] text-cream-dim">{JSON.stringify(manual.events, null, 2)}</pre>
                <div className="chip-label text-cream-faint">What will change</div>
                <PlanView plan={manual.plan} />
                <button className="btn btn-lime w-fit" disabled={!!busy} onClick={() => run("ma", async () => { await act("manual_apply", { contest_id: c.id, facts: manual.events }); setManual(null); setManualText(""); await reload(); })}>
                  Approve & apply
                </button>
              </>
            )}
            {manual.rejected?.length > 0 && <ErrorNote error={`Rejected: ${manual.rejected.map((r: any) => `${r.event_key}: ${r.errors.join(", ")}`).join("; ")}`} />}
          </div>
        )}
      </section>

      {c.kind === "draft" && (
        <section className="card grid gap-3 p-4">
          <h2 className="font-display text-xl font-bold uppercase">Adjustment</h2>
          <p className="text-sm text-cream-dim">For scoring the rules can&apos;t represent. The reason shows in the breakdown.</p>
          <div className="grid gap-2 md:grid-cols-[1.2fr_0.5fr_2fr_auto]">
            <select className="input" value={adj.target} onChange={(e) => setAdj({ ...adj, target: e.target.value })} aria-label="Target">
              <option value="">Choose pick or roster…</option>
              {view.rosters.map((r) => (
                <optgroup key={r.entry_id} label={r.username}>
                  <option value={`e:${r.entry_id}`}>Whole roster: {r.username}</option>
                  {r.picks.map((p) => <option key={p.pool_item_id} value={`p:${p.pool_item_id}`}>{p.name}</option>)}
                </optgroup>
              ))}
            </select>
            <input className="input" type="number" step="0.5" placeholder="±pts" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} aria-label="Points" />
            <input className="input" placeholder="Reason (required)" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} aria-label="Reason" />
            <button
              className="btn btn-ghost"
              disabled={!adj.target || !adj.points || adj.reason.trim().length < 3 || !!busy}
              onClick={() =>
                run("adj", async () => {
                  const [t, tid] = adj.target.split(":");
                  await act("add_adjustment", { contest_id: c.id, ...(t === "p" ? { pool_item_id: tid } : { entry_id: tid }), points: Number(adj.points), reason: adj.reason });
                  setAdj({ target: "", points: "", reason: "" });
                  await reload();
                })
              }
            >
              Add
            </button>
          </div>
        </section>
      )}
      <ErrorNote error={err} />

      <details className="card">
        <summary className="px-4 py-3 font-display text-xl font-bold uppercase">Revision history ({admin.revisions.length})</summary>
        <ul className="divide-y divide-line border-t border-line text-xs">
          {admin.revisions.map((r) => (
            <li key={r.id} className="grid gap-0.5 px-4 py-2">
              <div className="flex flex-wrap gap-2">
                <span className="font-semibold">{r.label || r.event_key}</span>
                <span className="chip-label text-cream-faint">rev {r.revision}</span>
                <span className={`chip-label ${r.state === "applied" ? "text-lime" : r.state === "pending_review" ? "text-amber" : "text-cream-faint"}`}>{r.state}</span>
                <span className="text-cream-faint">{r.origin} · {fmtTime(r.created_at)}</span>
              </div>
              {r.evidence && <div className="text-cream-dim">“{r.evidence}”</div>}
              {r.source_url && <div className="truncate text-cream-faint">{r.source_url}</div>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ----------------------------------------------------------------- review --
function ReviewTab({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { admin, view } = data;
  const { busy, err, run } = useAction();
  const [maps, setMaps] = useState<Record<string, Record<string, string>>>({});
  const open = admin.reviews.filter((r) => r.status === "open");
  const done = admin.reviews.filter((r) => r.status !== "open");
  const pool = view.draft?.pool ?? [];
  return (
    <div className="grid gap-3">
      {open.length === 0 && <div className="card p-4 text-sm text-cream-dim">Nothing waiting for review. Ambiguous names, conflicting results, missing facts and corrections after payout land here.</div>}
      {open.map((r) => (
        <section key={r.id} className="card grid gap-2 border-amber/40 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip-label text-amber">{r.kind.replace(/_/g, " ")}</span>
            <span className="font-semibold">{r.title}</span>
            <span className="ml-auto text-xs text-cream-faint">{fmtTime(r.created_at)}</span>
          </div>
          {r.detail?.facts && (
            <div className="text-xs text-cream-dim">
              {r.detail.facts.label ?? r.detail.facts.event_key}: {r.detail.facts.participants.map((p: any) => `${p.name}${p.result ? ` (${p.result})` : ""}${p.place ? ` #${p.place}` : ""}`).join(" vs ")} · {r.detail.facts.status}
              {r.detail.facts.evidence && <div>Evidence: “{r.detail.facts.evidence}”</div>}
              {r.detail.meta?.source_url && <div className="truncate">Source: {r.detail.meta.source_url}</div>}
            </div>
          )}
          {r.kind === "ambiguous_name" && (
            <div className="grid gap-2">
              {r.detail.ambiguous.map((a: any) => (
                <label key={a.name} className="flex flex-wrap items-center gap-2">
                  <span>“{a.name}” is</span>
                  <select className="input w-auto" value={maps[r.id]?.[a.name] ?? ""} onChange={(e) => setMaps({ ...maps, [r.id]: { ...maps[r.id], [a.name]: e.target.value } })}>
                    <option value="">choose…</option>
                    {a.candidates.map((cnd: any) => <option key={cnd.id} value={cnd.id}>{cnd.name}</option>)}
                    <optgroup label="Other picks">{pool.filter((p) => !a.candidates.some((cnd: any) => cnd.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
                  </select>
                </label>
              ))}
              <button className="btn btn-lime w-fit" disabled={!!busy || r.detail.ambiguous.some((a: any) => !maps[r.id]?.[a.name])} onClick={() => run(r.id, async () => { await act("resolve_review", { review_id: r.id, action: "map", mapping: maps[r.id] }); await reload(); })}>
                Save alias & apply
              </button>
            </div>
          )}
          {r.kind === "conflict" && r.detail.candidates && (
            <div className="grid gap-2">
              {r.detail.candidates.map((cand: any, i: number) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded bg-shell p-2 text-xs">
                  <span>{cand.participants.map((p: any) => `${p.name}${p.result ? ` (${p.result})` : ""}`).join(" vs ")} · winner {cand.winner ?? "—"}</span>
                  <button className="btn btn-ghost ml-auto px-2 py-1 text-xs" onClick={() => run(r.id, async () => { await act("resolve_review", { review_id: r.id, action: "choose", choice: i }); await reload(); })}>Use this</button>
                </div>
              ))}
            </div>
          )}
          {r.kind === "correction_after_payout" && (
            <p className="text-xs text-cream-dim">Chips were already paid. The ledger is preserved; acknowledging records that you saw it. Settle any make-goods outside the app or with a new contest.</p>
          )}
          <div className="flex gap-2">
            {r.kind === "correction_after_payout" ? (
              <button className="btn btn-ghost w-fit" onClick={() => run(r.id, async () => { await act("resolve_review", { review_id: r.id, action: "acknowledge" }); await reload(); })}>Acknowledge</button>
            ) : (
              <button className="btn btn-ghost w-fit" onClick={() => run(r.id, async () => { await act("resolve_review", { review_id: r.id, action: "dismiss" }); await reload(); })}>Dismiss</button>
            )}
          </div>
        </section>
      ))}
      <ErrorNote error={err} />
      {done.length > 0 && (
        <details className="card">
          <summary className="px-4 py-3 text-sm font-semibold">Resolved ({done.length})</summary>
          <ul className="divide-y divide-line border-t border-line text-xs">
            {done.map((r) => <li key={r.id} className="px-4 py-2"><span className="chip-label text-cream-faint">{r.kind}</span> {r.title} — <span className="text-cream-dim">{r.resolution}</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- settle --
function SettleTab({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { view } = data;
  const c = view.contest;
  const { busy, err, run } = useAction();
  const [outcome, setOutcome] = useState<string>(c.proposed_outcome_id ?? "");
  const [preview, setPreview] = useState<any>(null);
  if (c.status === "settled") {
    return (
      <section className="card p-4">
        <h2 className="font-display text-xl font-bold uppercase">Settled {fmtTime(c.settled_at)}</h2>
        <ul className="mt-2 grid gap-1 text-sm">
          {view.entrants.map((e) => <li key={e.entry_id} className="flex gap-2"><span className="flex-1">{e.username}</span><span className="chip-label">{e.status}</span><span className="num">payout {e.payout} · refund {e.refund}</span></li>)}
        </ul>
      </section>
    );
  }
  if (c.status === "canceled") return <section className="card p-4 text-sm">Canceled — every stake was refunded.</section>;
  return (
    <section className="card grid gap-3 p-4">
      <h2 className="font-display text-xl font-bold uppercase">Preview & settle</h2>
      {c.status !== "awaiting_settlement" && <p className="text-sm text-amber">The contest must be “awaiting settlement” to pay out ({c.kind === "bet" ? "a final result moves it there automatically, or use Setup" : "use Setup → Results are in"}). You can still preview.</p>}
      {c.kind === "bet" && (
        <label className="grid gap-1 text-sm">
          <span className="label">Final outcome {c.proposed_outcome_id ? "(from verified results)" : ""}</span>
          <select className="input max-w-sm" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Choose…</option>
            {view.outcomes.map((o) => <option key={o.id} value={o.id}>{o.label}{o.id === c.proposed_outcome_id ? " — verified" : ""}</option>)}
          </select>
        </label>
      )}
      <button className="btn btn-ghost w-fit" disabled={!!busy || (c.kind === "bet" && !outcome)} onClick={() => run("pv", async () => setPreview(await act("settlement_preview", { contest_id: c.id, outcome_id: outcome || null })))}>
        Preview payouts
      </button>
      {preview && (
        <div className="grid gap-2">
          <div className="text-sm">{preview.summary} Pot <Chips n={preview.pot} />.</div>
          {preview.open_reviews > 0 && <ErrorNote error={`${preview.open_reviews} review item(s) open — resolve them first.`} />}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-cream-faint"><tr><th>Entrant</th><th>Result</th><th className="num">Place</th><th className="num">Points</th><th className="num">Payout</th><th className="num">Refund</th><th className="num">Net</th></tr></thead>
              <tbody>
                {preview.lines.map((l: any) => (
                  <tr key={l.entry_id} className="border-t border-line">
                    <td className="py-1.5">{l.username}</td><td><span className="chip-label">{l.status}</span></td>
                    <td className="num">{l.place ?? "—"}</td><td className="num">{l.points ?? "—"}</td>
                    <td className="num">{l.payout}</td><td className="num">{l.refund}</td>
                    <td className={`num font-bold ${l.payout + l.refund - l.stake >= 0 ? "text-lime" : "text-rose"}`}>{l.payout + l.refund - l.stake}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="btn btn-lime w-fit"
            disabled={!!busy || preview.open_reviews > 0 || c.status !== "awaiting_settlement"}
            onClick={() => confirm("Pay out these chips? This can't be undone.") && run("settle", async () => { await act("settle", { contest_id: c.id, outcome_id: preview.outcome_id, hash: preview.hash }); setPreview(null); await reload(); })}
          >
            Confirm settlement
          </button>
          <p className="text-xs text-cream-faint">Confirming re-computes payouts on the server and refuses if anything changed since this preview. Retrying can&apos;t pay twice.</p>
        </div>
      )}
      <ErrorNote error={err} />
    </section>
  );
}
