import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EventFactsSchema, type EventFacts } from "../../scoring/schema";
import { extractFacts } from "../ai";
import { AppError } from "../errors";
import { htmlToText, safeFetch } from "./fetch";

export type SourceRow = {
  id: string;
  contest_id: string;
  kind: "fixture" | "sidebet_json" | "pgn" | "espn" | "html" | "manual";
  url: string | null;
  label: string;
  config: Record<string, unknown>;
};

export type ReadResult = {
  events: EventFacts[];
  rejected: { event_key: string; errors: string[] }[];
  source_url: string | null;
  origin: "feed" | "ai" | "fixture";
  notes: string;
  /** What the app could read, for the admin preview. */
  preview: string;
};

// ------------------------------------------------------------- fixtures --
const FixtureSchema = z.object({ title: z.string(), stages: z.array(z.array(z.unknown())) });

export function fixtureNames(): string[] {
  const dir = path.join(process.cwd(), "fixtures");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
}

export function readFixture(name: string, stage: number) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new AppError("validation", "Bad fixture name.");
  const file = path.join(process.cwd(), "fixtures", `${name}.json`);
  const fx = FixtureSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const idx = Math.max(0, Math.min(stage, fx.stages.length - 1));
  return { title: fx.title, stage: idx, stages: fx.stages.length, raw: fx.stages[idx] };
}

function validateList(raw: unknown[]) {
  const events: EventFacts[] = [];
  const rejected: ReadResult["rejected"] = [];
  for (const item of raw) {
    const p = EventFactsSchema.safeParse(item);
    if (p.success) events.push(p.data);
    else rejected.push({ event_key: String((item as { event_key?: unknown })?.event_key ?? "?"), errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  return { events, rejected };
}

// ------------------------------------------------------------------ PGN --
export function parsePgn(text: string, opts: { bracket?: string | null; round_prefix?: string } = {}): EventFacts[] {
  const games = text.split(/\n(?=\[Event\s)/);
  const out: EventFacts[] = [];
  for (const g of games) {
    const tag = (k: string) => g.match(new RegExp(`\\[${k}\\s+"([^"]*)"\\]`))?.[1]?.trim() ?? null;
    const white = tag("White");
    const black = tag("Black");
    if (!white || !black) continue;
    const result = tag("Result") ?? "*";
    const round = tag("Round");
    const status = result === "*" ? "in_progress" : "final";
    const wr = result === "1-0" ? "win" : result === "0-1" ? "loss" : result === "1/2-1/2" ? "draw" : null;
    const br = wr === "win" ? "loss" : wr === "loss" ? "win" : wr;
    const pair = [white, black].map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-")).sort().join("-vs-");
    out.push({
      event_key: `pgn:${round ?? "?"}:${pair}`,
      event_type: "match",
      label: `${white} vs ${black}`,
      round: round ? `${opts.round_prefix ?? "Round "}${round}` : null,
      bracket: opts.bracket === undefined ? "main" : opts.bracket,
      status,
      participants: [
        { name: white, result: status === "final" ? wr : null, score: status === "final" ? (wr === "win" ? 1 : wr === "draw" ? 0.5 : 0) : null },
        { name: black, result: status === "final" ? br : null, score: status === "final" ? (br === "win" ? 1 : br === "draw" ? 0.5 : 0) : null },
      ],
      winner: wr === "win" ? white : wr === "loss" ? black : null,
      attributes: { result, ...(tag("GameURL") ? { game_url: tag("GameURL")!.slice(0, 120) } : {}), ...(tag("Date") ? { date: tag("Date")! } : {}) },
      evidence: `[White "${white}"] [Black "${black}"] [Result "${result}"]${round ? ` [Round "${round}"]` : ""}`,
    });
  }
  return out;
}

// ----------------------------------------------------------------- ESPN --
type EspnCompetitor = { homeAway?: string; score?: string; winner?: boolean; team?: { displayName?: string; abbreviation?: string } };
type EspnEvent = {
  id: string;
  name?: string;
  shortName?: string;
  competitions?: { competitors?: EspnCompetitor[] }[];
  status?: { period?: number; displayClock?: string; type?: { state?: string; completed?: boolean; shortDetail?: string; detail?: string } };
};

export function parseEspn(json: unknown, filter?: { event_id?: string; team?: string }): EventFacts[] {
  const evs = ((json as { events?: EspnEvent[] })?.events ?? []).slice(0, 200);
  const out: EventFacts[] = [];
  for (const e of evs) {
    if (filter?.event_id && e.id !== filter.event_id) continue;
    const comps = e.competitions?.[0]?.competitors ?? [];
    if (comps.length !== 2) continue;
    if (filter?.team && !comps.some((c) => (c.team?.displayName ?? "").toLowerCase().includes(filter.team!.toLowerCase()))) continue;
    const state = e.status?.type?.state;
    const status = e.status?.type?.completed ? "final" : state === "in" ? "in_progress" : state === "post" ? "final" : "scheduled";
    const ordered = [...comps].sort((a) => (a.homeAway === "away" ? -1 : 1));
    const participants = ordered.map((c) => ({
      name: c.team?.displayName ?? c.team?.abbreviation ?? "?",
      score: c.score ?? null,
      result: status === "final" ? (c.winner ? ("win" as const) : comps.some((x) => x.winner) ? ("loss" as const) : ("draw" as const)) : null,
    }));
    const winner = status === "final" ? (ordered.find((c) => c.winner)?.team?.displayName ?? null) : null;
    out.push({
      event_key: `espn:${e.id}`,
      event_type: "game",
      label: e.shortName ?? e.name ?? e.id,
      status,
      participants,
      winner,
      attributes: {
        period: e.status?.period ?? null,
        clock: e.status?.displayClock ?? null,
        detail: (e.status?.type?.shortDetail ?? e.status?.type?.detail ?? "").slice(0, 120),
        overtime: /OT/.test(e.status?.type?.shortDetail ?? "") || (e.status?.period ?? 0) > 4,
      },
      evidence: `${e.shortName ?? e.name}: ${participants.map((p) => `${p.name} ${p.score ?? ""}`).join(" – ")} (${e.status?.type?.shortDetail ?? state})`,
    });
  }
  return out;
}

// ------------------------------------------------------------- dispatch --
export async function readSource(src: SourceRow, aiContext: string): Promise<ReadResult> {
  const cfg = src.config ?? {};
  if (src.kind === "manual") throw new AppError("validation", "Manual sources are entered by an admin, not fetched.");
  if (src.kind === "fixture") {
    const fx = readFixture(String(cfg.fixture ?? ""), Number(cfg.stage ?? 0));
    const v = validateList(fx.raw);
    return { ...v, source_url: `fixture://${cfg.fixture}#stage-${fx.stage + 1}`, origin: "fixture", notes: `DEMO FIXTURE “${fx.title}”, stage ${fx.stage + 1} of ${fx.stages}`, preview: JSON.stringify(fx.raw, null, 2).slice(0, 4000) };
  }
  if (!src.url) throw new AppError("validation", "This source has no URL.");
  if (src.kind === "sidebet_json") {
    const r = await safeFetch(src.url, "application/json");
    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new AppError("validation", "Feed isn't valid JSON.");
    }
    const list = Array.isArray(data) ? data : ((data as { events?: unknown[] })?.events ?? []);
    return { ...validateList(list), source_url: r.url, origin: "feed", notes: `Side Bet JSON feed (${r.bytes} bytes)`, preview: r.text.slice(0, 4000) };
  }
  if (src.kind === "pgn") {
    const r = await safeFetch(src.url, "application/x-chess-pgn, text/plain");
    const events = parsePgn(r.text, { bracket: (cfg.bracket as string | null | undefined) ?? "main" });
    return { ...validateList(events), source_url: r.url, origin: "feed", notes: `PGN feed: ${events.length} games (${r.bytes} bytes)`, preview: r.text.slice(0, 4000) };
  }
  if (src.kind === "espn") {
    const r = await safeFetch(src.url, "application/json");
    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new AppError("validation", "Feed isn't valid JSON.");
    }
    const events = parseEspn(data, { event_id: cfg.event_id as string | undefined, team: cfg.team as string | undefined });
    return { ...validateList(events), source_url: r.url, origin: "feed", notes: `ESPN scoreboard: ${events.length} matching games`, preview: JSON.stringify(events, null, 2).slice(0, 4000) };
  }
  // html: AI extraction from page text
  const r = await safeFetch(src.url, "text/html, text/plain");
  const text = /html/i.test(r.contentType) || /<html|<body|<table/i.test(r.text) ? htmlToText(r.text) : r.text;
  const x = await extractFacts(text, aiContext);
  return { events: x.events, rejected: x.rejected, source_url: r.url, origin: "ai", notes: `${x.provider}: ${x.notes}`, preview: text.slice(0, 4000) };
}
