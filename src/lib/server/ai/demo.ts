import type { WireEvents, WireProposal } from "./wire";

/**
 * DEMO PARSER — deterministic stand-in for the AI when no ANTHROPIC_API_KEY
 * is configured. Understands common phrasings only; anything else is flagged
 * as unsupported so the admin sees exactly what it didn't handle.
 */

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : (WORDS[s.toLowerCase()] ?? NaN));

type WCond = WireProposal["scope"][number];
const c = (fact: string, op: WCond["op"], value: WCond["value"] = null, value_fact: string | null = null): WCond => ({ fact, op, value, value_list: null, value_fact });

export function demoProposeRules(instructions: string): WireProposal {
  const rules: WireProposal["rules"] = [];
  const scope: WCond[] = [];
  const unsupported: WireProposal["unsupported"] = [];
  const questions: WireProposal["questions"] = [];
  const options: WireProposal["options"] = { unseeded: "lowest", forfeits: "count", final_only: true };
  const sentences = instructions
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const lower = instructions.toLowerCase();
  for (const s of sentences) {
    const t = s.toLowerCase();
    let handled = false;
    const win = t.match(/(\d+(?:\.\d+)?)\s*(?:points?|pts?)\s*(?:for|per)\s*(?:a|an|each|every)?\s*(match|game|race|round)?\s*(?:win|victory)/);
    if (win) {
      rules.push({ id: `${win[2] ?? "match"}_win`, type: "points", label: `${cap(win[2] ?? "match")} win`, points: Number(win[1]), placement: null, stat: null, points_per: null, per: null, max: null, when: [c("self.result", "eq", "win")] });
      handled = true;
    }
    const upset =
      t.match(/(\d+(?:\.\d+)?)\s*(?:extra|bonus|more|additional)\b[^.]*?(?:beat|beats|defeat|defeats|upset)[^.]*?higher[- ]seed/) ??
      t.match(/(?:beat|beats|defeat|defeats|upset)[^.]*?higher[- ]seed[^.\d]*?(\d+(?:\.\d+)?)\s*(?:extra|bonus|more|additional)?\s*(?:points?|pts?)/);
    if (upset) {
      rules.push({ id: "upset_bonus", type: "points", label: "Upset bonus", points: Number(upset[1]), placement: null, stat: null, points_per: null, per: null, max: null, when: [c("self.result", "eq", "win"), c("opponent.seed", "lt", null, "self.seed")] });
      handled = true;
    }
    const draw = t.match(/(\d+(?:\.\d+)?)\s*(?:points?|pts?)\s*(?:for|per)\s*(?:a|each)?\s*(?:draw|tie)/);
    if (draw) {
      rules.push({ id: "draw", type: "points", label: "Draw", points: Number(draw[1]), placement: null, stat: null, points_per: null, per: null, max: null, when: [c("self.result", "eq", "draw")] });
      handled = true;
    }
    const bracket = t.match(/only\s+(main|championship|upper|winners?)[- ]bracket/);
    if (bracket) {
      scope.push(c("event.bracket", "eq", bracket[1]));
      handled = true;
    }
    const placements = [...t.matchAll(/(\d+)(?:st|nd|rd|th)\b\s*(?:place)?[^,;\d]*?(\d+(?:\.\d+)?)\s*(?:points?|pts?)?/g)];
    if (placements.length) {
      rules.push({ id: "placement", type: "placement", label: "Finish", points: null, placement: placements.map((m) => ({ place: Number(m[1]), points: Number(m[2]) })), stat: null, points_per: null, per: null, max: null, when: [] });
      handled = true;
    }
    const winnerOf = !placements.length && t.match(/(\d+(?:\.\d+)?)\s*(?:points?|pts?)\s*(?:to|for)\s*(?:the\s*)?winner\s*of\s*(?:each|every|a)?\s*(race|heat|round|game)/);
    if (winnerOf) {
      rules.push({ id: `${winnerOf[2]}_win`, type: "placement", label: `${cap(winnerOf[2])} win`, points: null, placement: [{ place: 1, points: Number(winnerOf[1]) }], stat: null, points_per: null, per: null, max: null, when: [] });
      handled = true;
    }
    const stat = t.match(/(\d+(?:\.\d+)?)\s*(?:points?|pts?)\s*(?:per|for each|for every)\s*([a-z]+)/);
    if (stat && !win && !draw && !winnerOf && !/win|draw|race|match|game/.test(stat[2])) {
      rules.push({ id: `${stat[2]}_pts`, type: "stat", label: `${cap(stat[2])}`, points: null, placement: null, stat: stat[2], points_per: Number(stat[1]), per: 1, max: null, when: [] });
      handled = true;
    }
    if (/forfeit|walkover/.test(t)) {
      options.forfeits = /(don'?t|do not|no|never)\b[^.]*count|ignore|excluded?/.test(t) ? "ignore" : "count";
      handled = true;
    }
    if (/unseeded/.test(t)) {
      options.unseeded = /no bonus|don'?t|never/.test(t) ? "no_bonus" : "lowest";
      handled = true;
    }
    if (!handled) unsupported.push({ text: s, reason: "The demo parser couldn't map this sentence to a rule. Add a manual adjustment or configure an AI key." });
  }
  if (rules.some((r) => r.id === "upset_bonus") && !/unseeded/.test(lower)) {
    questions.push({ id: "unseeded", question: "If a player has no seed, how should upsets work?", why: "The upset bonus compares seeds.", options: ["Treat unseeded as the lowest seed", "No upset bonus involving unseeded players"], option_key: "unseeded" });
  }
  if (rules.length && !/forfeit|walkover/.test(lower)) {
    questions.push({ id: "forfeits", question: "Do forfeit wins count?", why: "A walkover would otherwise score like a normal win.", options: ["Forfeits count as wins", "Ignore forfeits"], option_key: "forfeits" });
  }
  if (scope.length) {
    questions.push({ id: "bracket", question: "What does the results source call the main bracket?", why: "Only events labeled with that bracket will score.", options: ["main"], option_key: null });
  }
  return {
    summary: rules.map((r) => (r.type === "points" ? `${r.label} +${r.points}` : r.label)).join(" · ") || "No rules recognized",
    scope,
    rules,
    options,
    questions,
    unsupported,
  };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse short admin result statements, e.g.
 *   "Josiah won race two"           -> race-2, Josiah place 1
 *   "Mara finished 2nd in race 3"   -> race-3, Mara place 2
 *   "Okafor beat Lindqvist 2-1 in round 3" -> match, winner Okafor
 *   "Comets 101 Owls 98 final"      -> game score, final
 */
export function demoParseResult(text: string): WireEvents {
  const events: WireEvents["events"] = [];
  const notes: string[] = [];
  for (const raw of text.split(/\n|;|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean)) {
    const s = raw.replace(/\.$/, "");
    let m = s.match(/^(.+?)\s+(?:won|wins|took)\s+(?:the\s+)?(race|heat|game|round|match)\s+(\w+)$/i);
    if (m && !Number.isNaN(toNum(m[3]))) {
      const n = toNum(m[3]);
      events.push(ev(`${m[2].toLowerCase()}-${n}`, m[2].toLowerCase() === "race" || m[2].toLowerCase() === "heat" ? "race" : "match", `${cap(m[2].toLowerCase())} ${n}`, [p(m[1], { place: 1, result: "win" })], m[1], s));
      continue;
    }
    m = s.match(/^(.+?)\s+(?:finished|came|placed)\s+(\w+?)(?:st|nd|rd|th)?\s+(?:place\s+)?in\s+(?:the\s+)?(race|heat)\s+(\w+)$/i);
    if (m && !Number.isNaN(toNum(m[2])) && !Number.isNaN(toNum(m[4]))) {
      const n = toNum(m[4]);
      events.push(ev(`${m[3].toLowerCase()}-${n}`, "race", `${cap(m[3].toLowerCase())} ${n}`, [p(m[1], { place: toNum(m[2]), result: toNum(m[2]) === 1 ? "win" : "loss" })], toNum(m[2]) === 1 ? m[1] : null, s));
      continue;
    }
    m = s.match(/^(.+?)\s+(?:beat|beats|def\.?|defeated|over)\s+(.+?)(?:\s+(\d+(?:\.5)?)\s*[-–]\s*(\d+(?:\.5)?))?(?:\s+in\s+(?:the\s+)?(.+))?$/i);
    if (m) {
      const round = m[5] ?? null;
      const key = `${round ? round.toLowerCase().replace(/\s+/g, "-") + ":" : ""}${[m[1], m[2]].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-")).sort().join("-vs-")}`;
      events.push({ ...ev(key, "match", `${m[1]} vs ${m[2]}`, [p(m[1], { result: "win", score: m[3] ?? null }), p(m[2], { result: "loss", score: m[4] ?? null })], m[1], s), round, bracket: "main" });
      continue;
    }
    m = s.match(/^(.+?)\s+(\d+)\s*,?\s+(.+?)\s+(\d+)(?:\s*\(?(final|ft|in progress|live|q\d|halftime)\)?)?$/i);
    if (m) {
      const final = /final|ft/i.test(m[5] ?? "");
      const a = Number(m[2]);
      const b = Number(m[4]);
      const winner = final ? (a > b ? m[1] : b > a ? m[3] : null) : null;
      events.push({ ...ev(`game:${[m[1], m[3]].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-")).sort().join("-vs-")}`, "game", `${m[1]} vs ${m[3]}`, [p(m[1], { score: String(a), result: final ? (a > b ? "win" : a < b ? "loss" : "draw") : null }), p(m[3], { score: String(b), result: final ? (b > a ? "win" : a > b ? "loss" : "draw") : null })], winner, s), status: final ? "final" : "in_progress" });
      continue;
    }
    notes.push(`Couldn't understand: "${s}"`);
  }
  return { events, notes: notes.join(" ") || "Parsed by the demo parser." };
}

function p(name: string, o: { place?: number; result?: "win" | "loss" | "draw" | null; score?: string | null }) {
  return { name: name.trim(), seed: null, score: o.score ?? null, place: o.place ?? null, result: o.result ?? null, stats: [] };
}
function ev(key: string, type: "match" | "race" | "game", label: string, participants: ReturnType<typeof p>[], winner: string | null, evidence: string): WireEvents["events"][number] {
  return { event_key: key, event_type: type, label, round: null, bracket: null, status: "final", winner: winner?.trim() ?? null, is_forfeit: false, participants, attributes: [], evidence };
}
