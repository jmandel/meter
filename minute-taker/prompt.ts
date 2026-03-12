import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const PROMPTS_DIR = join(dirname(import.meta.path), "prompts");

function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  let text = readFileSync(join(PROMPTS_DIR, name), "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

export function buildSystemPrompt(config: {
  meetingId: string;
  meetingRunId: string;
}): string {
  return loadPrompt("system.md", config);
}

export function buildInitialPrompt(): string {
  return "I'm ready to take meeting minutes. Transcript chunks will be pasted directly into this conversation. I'll maintain minutes.md incrementally, tolerate repeated growing speaker turns, and record action items inline as TODO(Name): ...";
}

export function formatChunkMessage(
  chunk: { segmentIndex: number; content: string; isFirst: boolean },
): string {
  const header = chunk.isFirst
    ? `--- Transcript chunk ${chunk.segmentIndex} (initial) ---`
    : `--- Transcript chunk ${chunk.segmentIndex} ---`;
  const instruction = chunk.isFirst
    ? "Create minutes.md with initial minutes. Also check attendees.md for the attendee list."
    : "Update minutes.md with this content. The first line may repeat a previously seen growing speaker turn.";
  return `${header}\n${chunk.content}\n--- end chunk ---\n${instruction}`;
}

export function buildFinalMessage(
  chunk: { segmentIndex: number; content: string } | null,
): string {
  const finalPrompt = loadPrompt("final.md");
  if (chunk) {
    return `--- Final transcript chunk ${chunk.segmentIndex} (meeting ended) ---\n${chunk.content}\n--- end chunk ---\n${finalPrompt}`;
  }
  return finalPrompt;
}
