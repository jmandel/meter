import { expect, test } from "bun:test";

import { applyMinutesPatch, createMinutesState, renderMinutesMarkdown } from "./state";

test("minutes state applies semantic patches and renders inline todos", () => {
  let state = createMinutesState({
    meetingId: "999001",
    meetingRunId: "019ce326",
    title: "FHIR-I WG Call",
    startedAt: "2026-03-12T17:45:06.262Z",
    status: "live",
  });

  state = applyMinutesPatch(state, {
    op: "merge_attendees",
    attendees: [
      { name: "Lloyd McKenzie", role: "chair", present: true },
      { name: "Rick Geimer", role: "scribe", present: true },
    ],
  });
  state = applyMinutesPatch(state, {
    op: "upsert_section",
    sectionId: "capstmt",
    title: "CapabilityStatement & Feature Framework",
    sourceRefs: [{ ts: "00:32", kind: "speech" }],
  });
  state = applyMinutesPatch(state, {
    op: "append_bullet",
    sectionId: "capstmt",
    text: "CapabilityStatement has become unwieldy in real deployments.",
    sourceRefs: [{ ts: "00:32", kind: "speech" }],
  });
  state = applyMinutesPatch(state, {
    op: "append_decision",
    sectionId: "capstmt",
    text: "Combined searches SHOULD default to SHOULD unless evidence supports SHALL.",
    sourceRefs: [{ ts: "04:53", kind: "speech" }],
  });
  state = applyMinutesPatch(state, {
    op: "append_todo",
    sectionId: "capstmt",
    assignee: "Cooper Thompson",
    text: "Submit the FHIR-34735 editorial PR.",
    sourceRefs: [{ ts: "02:53", kind: "speech" }],
  });

  const markdown = renderMinutesMarkdown(state);

  expect(markdown).toContain("### CapabilityStatement & Feature Framework");
  expect(markdown).toContain("- CapabilityStatement has become unwieldy in real deployments.");
  expect(markdown).toContain("- Decision: Combined searches SHOULD default to SHOULD unless evidence supports SHALL.");
  expect(markdown).toContain("- TODO(Cooper Thompson): Submit the FHIR-34735 editorial PR.");
});
