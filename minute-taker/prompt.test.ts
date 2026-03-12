import { expect, test } from "bun:test";
import { buildFinalMessage, buildInitialPrompt, buildSystemPrompt, formatChunkMessage } from "./prompt";

test("minute taker prompts rely on transcript joins instead of attendees.md", () => {
  const systemPrompt = buildSystemPrompt({
    meetingId: "999001",
    meetingRunId: "run-123",
  });

  expect(systemPrompt).toContain("Use the transcript's join/leave lines as the attendee source.");
  expect(systemPrompt).toContain("one attendee per bullet");
  expect(systemPrompt).toContain("[FHIR-34735](https://jira.hl7.org/browse/FHIR-34735)");
  expect(systemPrompt).toContain("messy Jira URLs");
  expect(systemPrompt).not.toContain("check attendees.md");

  const initialPrompt = buildInitialPrompt();
  expect(initialPrompt).toContain("join/leave lines as the attendee source");

  const firstChunkMessage = formatChunkMessage({
    segmentIndex: 1,
    content: "[00:05 joins] Lloyd McKenzie, Rick Geimer",
    isFirst: true,
  });
  expect(firstChunkMessage).toContain("Use join/leave lines in the transcript to maintain attendees.");
  expect(firstChunkMessage).not.toContain("attendees.md");
});

test("final prompt keeps todos inline and forbids comma-list attendee bullets", () => {
  const finalMessage = buildFinalMessage(null);
  expect(finalMessage).toContain("Review all inline `TODO(Name): ...` items");
  expect(finalMessage).toContain("Do not use a single comma-separated bullet of names.");
  expect(finalMessage).toContain("[FHIR-34735](https://jira.hl7.org/browse/FHIR-34735)");
  expect(finalMessage).not.toContain("## Action Items");
});
