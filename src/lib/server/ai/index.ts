import { aiMode } from "../config";
import { AppError } from "../errors";
import { claudeExtractFacts, claudeProposeRules } from "./claude";
import { demoParseResult, demoProposeRules } from "./demo";
import { eventsFromWire, proposalFromWire } from "./wire";

/** Admin-only AI. Every output is re-validated by the strict schemas before use. */
export function aiProviderName() {
  return aiMode() === "claude" ? "Claude" : "Demo parser (no AI key)";
}

export async function proposeRules(instructions: string, context: string) {
  const wire = aiMode() === "claude" ? await claudeProposeRules(instructions, context) : demoProposeRules(instructions);
  return { provider: aiProviderName(), raw: wire, result: proposalFromWire(wire) };
}

export async function extractFacts(content: string, context: string) {
  if (aiMode() !== "claude") {
    throw new AppError(
      "validation",
      "Reading unstructured pages needs an AI key (ANTHROPIC_API_KEY). In demo mode, use a structured feed (Side Bet JSON, PGN, ESPN) or enter results manually.",
    );
  }
  const wire = await claudeExtractFacts(content.slice(0, 120_000), context);
  return { provider: aiProviderName(), notes: wire.notes, ...eventsFromWire(wire) };
}

export async function parseManualResult(text: string, context: string) {
  const wire = aiMode() === "claude" ? await claudeExtractFacts(text, context) : demoParseResult(text);
  return { provider: aiProviderName(), notes: wire.notes, ...eventsFromWire(wire) };
}
