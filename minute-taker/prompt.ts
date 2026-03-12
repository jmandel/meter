import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROMPTS_DIR = join(dirname(import.meta.path), "prompts");
const STATE_SCHEMA_PATH = join(dirname(import.meta.path), "state.ts");

function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  let text = readFileSync(join(PROMPTS_DIR, name), "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

function loadStateSchema(): string {
  const source = readFileSync(STATE_SCHEMA_PATH, "utf-8");
  const marker = "\nfunction appendUnique";
  const end = source.indexOf(marker);
  return (end === -1 ? source : source.slice(0, end)).trim();
}

function buildSchemaAppendix(): string {
  return [
    "",
    "## TypeScript Schema",
    "",
    "If you are maintaining structured minutes state or an append-only patch log, use this schema:",
    "",
    "```ts",
    loadStateSchema(),
    "```",
  ].join("\n");
}

export function buildSystemPrompt(config: {
  meetingId: string;
  meetingRunId: string;
}): string {
  return `${loadPrompt("system.md", config)}\n${buildSchemaAppendix()}`;
}

export function buildInitialPrompt(): string {
  return "I'm ready to take meeting minutes. I'll treat minutes.state.json as canonical, submit validated ops through ./minute-op, tolerate repeated growing speaker turns, and keep action items inline as TODO(Name): ...";
}

export function formatChunkMessage(
  chunk: { segmentIndex: number; content: string; isFirst: boolean },
): string {
  const header = chunk.isFirst
    ? `--- Transcript chunk ${chunk.segmentIndex} (initial) ---`
    : `--- Transcript chunk ${chunk.segmentIndex} ---`;
  const instruction = chunk.isFirst
    ? "Create the initial structured minutes state with ./minute-op submit calls. Also check attendees.md for the attendee list."
    : "Update the structured minutes state with ./minute-op submit. The first line may repeat a previously seen growing speaker turn.";
  return `${header}\n${chunk.content}\n--- end chunk ---\n${instruction}`;
}

export function buildFinalMessage(
  chunk: { segmentIndex: number; content: string } | null,
): string {
  const finalPrompt = `${loadPrompt("final.md")}\n${buildSchemaAppendix()}`;
  if (chunk) {
    return `--- Final transcript chunk ${chunk.segmentIndex} (meeting ended) ---\n${chunk.content}\n--- end chunk ---\n${finalPrompt}`;
  }
  return finalPrompt;
}
