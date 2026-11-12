import { eventInScope, scoreEvent } from "../scoring/engine";
import type { EventFacts, Ruleset } from "../scoring/schema";

type PoolLite = { id: string; name: string; seed: number | null };

export type RuleExample = {
  title: string;
  facts: EventFacts;
  note: string | null;
  results: { name: string; total: number; lines: { label: string; points: number }[] }[];
};

/** Example results + breakdowns shown before an admin approves rules. */
export function ruleExamples(rs: Ruleset, pool: PoolLite[]): RuleExample[] {
  const seeded = pool.filter((p) => p.seed).sort((a, b) => a.seed! - b.seed!);
  const top = seeded[0] ?? { id: "x1", name: "Top Seed", seed: 1 };
  const low = seeded[seeded.length - 1] && seeded.length > 1 ? seeded[seeded.length - 1] : { id: "x2", name: "Lower Seed", seed: 8 };
  const unseeded = pool.find((p) => !p.seed) ?? { id: "x3", name: "Unseeded Player", seed: null };
  const bracketCond = rs.scope.find((c) => c.fact === "event.bracket" && c.op === "eq");
  const bracket = bracketCond ? String(bracketCond.value) : "main";
  const usesPlacement = rs.rules.some((r) => r.type === "placement");
  const stat = rs.rules.find((r) => r.type === "stat");
  const mentionsDraw = rs.rules.some((r) => r.when.some((c) => c.value === "draw"));

  const match = (title: string, a: PoolLite, b: PoolLite, o: Partial<EventFacts> & { result?: "win" | "draw" } = {}): { title: string; facts: EventFacts } => ({
    title,
    facts: {
      event_key: `example-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      event_type: "match",
      label: `${a.name} vs ${b.name}`,
      round: "Round 1",
      bracket,
      status: "final",
      participants: [
        { name: a.name, seed: a.seed, result: o.result === "draw" ? "draw" : "win" },
        { name: b.name, seed: b.seed, result: o.result === "draw" ? "draw" : "loss" },
      ],
      winner: o.result === "draw" ? null : a.name,
      ...o,
    } as EventFacts,
  });

  const cases: { title: string; facts: EventFacts }[] = [];
  if (usesPlacement) {
    const names = (pool.length >= 3 ? pool.slice(0, 3) : [top, low, unseeded]).map((p) => p);
    cases.push({
      title: "Race finish",
      facts: {
        event_key: "example-race", event_type: "race", label: "Example race", status: "final", bracket,
        participants: names.map((p, i) => ({ name: p.name, seed: p.seed, place: i + 1, result: i === 0 ? "win" : "loss" })),
        winner: names[0].name,
      },
    });
  } else {
    cases.push(match("Favorite wins", top, low));
    cases.push(match("Upset", low, top));
    cases.push(match("Unseeded beats a seed", unseeded, top));
    if (mentionsDraw) cases.push(match("Draw", top, low, { result: "draw" }));
    cases.push(match("Forfeit win", top, low, { is_forfeit: true }));
    if (bracketCond) cases.push(match("Outside the counted bracket", low, top, { bracket: "consolation" }));
  }
  if (stat?.type === "stat") {
    cases.push({
      title: `Stat: ${stat.label}`,
      facts: {
        event_key: "example-stat", event_type: "game", label: "Example game", status: "final", bracket,
        participants: [{ name: top.name, seed: top.seed, result: "win", stats: { [stat.stat]: 3 * stat.per } }],
        winner: top.name,
      },
    });
  }

  return cases.map(({ title, facts }) => {
    const matched = new Map<number, string>(facts.participants.map((_, i) => [i, `p${i}`]));
    const lines = scoreEvent(rs, facts, matched);
    const scope = eventInScope(rs, facts);
    return {
      title,
      facts,
      note: scope.ok ? null : `Scores nothing: ${scope.reason}`,
      results: facts.participants.map((p, i) => {
        const mine = lines.filter((l) => l.pool_item_id === `p${i}`);
        return {
          name: `${p.name}${p.seed ? ` (seed ${p.seed})` : " (unseeded)"}`,
          total: mine.reduce((s, l) => s + l.points, 0),
          lines: mine.map((l) => ({ label: l.label, points: l.points })),
        };
      }),
    };
  });
}
