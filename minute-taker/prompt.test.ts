import { expect, test } from "bun:test";

import { buildFinalMessage, buildSystemPrompt } from "./prompt";

test("buildSystemPrompt appends the typed minutes schema", () => {
  const prompt = buildSystemPrompt({
    meetingId: "999001",
    meetingRunId: "019ce326",
  });

  expect(prompt).toContain("./minute-op submit");
  expect(prompt).toContain("## TypeScript Schema");
  expect(prompt).toContain("export interface MinutesState");
  expect(prompt).toContain("export type MinutesPatchOperation");
});

test("buildFinalMessage appends the typed minutes schema", () => {
  const prompt = buildFinalMessage(null);

  expect(prompt).toContain("./minute-op submit");
  expect(prompt).toContain("## TypeScript Schema");
  expect(prompt).toContain("export interface MinutesState");
  expect(prompt).toContain("Keep `TODO(Name): ...` items inline");
});
