import { expect, test } from "bun:test";
import { buildFinalMessage, buildInitialPrompt, buildSystemPrompt, formatChunkMessage } from "./prompt";

test("minute taker prompts rely on transcript joins instead of attendees.md", () => {
  const systemPrompt = buildSystemPrompt({
    meetingId: "999001",
    meetingRunId: "run-123",
  });

  expect(systemPrompt).toContain("Use the transcript's join/leave lines as the attendee source.");
  expect(systemPrompt).toContain("One attendee per bullet.");
  expect(systemPrompt).toContain("[FHIR-34735](https://jira.hl7.org/browse/FHIR-34735)");
  expect(systemPrompt).toContain("For tracker-heavy sections");
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

test("system prompt uses the requested template guidance when no custom prompt is supplied", () => {
  const systemPrompt = buildSystemPrompt({
    meetingId: "999001",
    meetingRunId: "run-123",
    promptTemplateId: "decision-journal",
  });

  expect(systemPrompt).toContain("Write the minutes as a decision journal.");
  expect(systemPrompt).toContain("Capture each substantive decision or tentative consensus as its own record.");
});

test("final prompt keeps the active minutes guidance style and focuses on cleanup", () => {
  const finalMessage = buildFinalMessage(null);
  expect(finalMessage).toContain("Keep following the existing `## Minutes Guidance` style already in effect for this run.");
  expect(finalMessage).toContain("Remove obvious live placeholders like \"meeting in progress\"");
  expect(finalMessage).not.toContain("## Finalization Guidance");
});
