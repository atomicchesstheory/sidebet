import type { Condition, Rule, Ruleset } from "./scoring/schema";

const FACT: Record<string, string> = {
  "self.result": "result",
  "self.seed": "their seed",
  "self.place": "finishing place",
  "opponent.seed": "opponent's seed",
  "opponent.result": "opponent's result",
  "event.bracket": "bracket",
  "event.round": "round",
  "event.is_forfeit": "forfeit",
  "event.status": "status",
  "event.winner": "winner",
};
const OP: Record<string, string> = { eq: "is", neq: "isn't", in: "is one of", not_in: "isn't one of", gt: ">", gte: "≥", lt: "<", lte: "≤" };

export function describeCondition(c: Condition): string {
  const f = FACT[c.fact] ?? c.fact.replace(/^(event|self)\./, "").replace(/^opponent\./, "opponent ").replace(/_/g, " ");
  if (c.fact === "opponent.seed" && c.op === "lt" && c.value_fact === "self.seed") return "opponent is a higher seed";
  if (c.op === "true") return `${f}: yes`;
  if (c.op === "false") return `${f}: no`;
  if (c.op === "exists") return `${f} is known`;
  if (c.op === "missing") return `${f} is unknown`;
  const rhs = c.value_fact ? (FACT[c.value_fact] ?? c.value_fact) : Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
  return `${f} ${OP[c.op] ?? c.op} ${rhs}`;
}

export function describeRule(r: Rule): string {
  const when = r.when.length ? ` when ${r.when.map(describeCondition).join(" and ")}` : "";
  if (r.type === "points") return `${r.label}: ${r.points >= 0 ? "+" : ""}${r.points}${when}`;
  if (r.type === "placement")
    return `${r.label}: ${Object.entries(r.table)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([p, v]) => `${ordinal(Number(p))} +${v}`)
      .join(", ")}${when}`;
  return `${r.label}: ${r.points_per >= 0 ? "+" : ""}${r.points_per} per ${r.per === 1 ? "" : r.per + " "}${r.stat.replace(/_/g, " ")}${r.max !== undefined ? ` (max ${r.max})` : ""}${when}`;
}

export function describeRuleset(rs: Ruleset): string[] {
  const out = rs.rules.map(describeRule);
  if (rs.scope.length) out.push(`Only counts when ${rs.scope.map(describeCondition).join(" and ")}.`);
  out.push(rs.options.final_only ? "Only final results score; provisional results show but don't count yet." : "Provisional results score immediately.");
  out.push(rs.options.forfeits === "ignore" ? "Forfeits don't count." : "Forfeits count like normal results.");
  out.push(rs.options.unseeded === "lowest" ? "Unseeded players rank below every seed." : "No seed-based bonuses involving unseeded players.");
  return out;
}

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
