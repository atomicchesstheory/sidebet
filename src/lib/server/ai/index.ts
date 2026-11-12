import { demoParseResult, demoProposeRules } from "./demo";
import { eventsFromWire, proposalFromWire } from "./wire";

/**
 * Built-in, rule-based parser. No AI service is called and no paid API is
 * used anywhere in the app. Every output is validated by the strict schemas.
 */
export const PARSER_NAME = "Built-in parser";

export async function proposeRules(instructions: string) {
  const wire = demoProposeRules(instructions);
  return { provider: PARSER_NAME, raw: wire, result: proposalFromWire(wire) };
}

export async function parseManualResult(text: string) {
  const wire = demoParseResult(text);
  return { provider: PARSER_NAME, notes: wire.notes, ...eventsFromWire(wire) };
}
