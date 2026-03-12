import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { applyMinutesOperation, initializeMinutesStore, loadMinutesState } from "./store";

test("applyMinutesOperation appends jsonl and regenerates markdown", () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "meter-minute-store-"));
  try {
    initializeMinutesStore(runDir, {
      meetingId: "999001",
      meetingRunId: "019ce326",
      title: "FHIR-I WG Call",
      startedAt: "2026-03-12T17:45:06.262Z",
      status: "live",
    });

    applyMinutesOperation(runDir, {
      op: "upsert_section",
      sectionId: "announcements",
      title: "Announcements",
      sourceRefs: [{ ts: "00:24", kind: "speech" }],
    });
    applyMinutesOperation(runDir, {
      op: "append_todo",
      sectionId: "announcements",
      assignee: "Cooper Thompson",
      text: "Submit the FHIR-34735 editorial PR.",
      sourceRefs: [{ ts: "02:53", kind: "speech" }],
    });

    const state = loadMinutesState(runDir);
    const markdown = readFileSync(path.join(runDir, "minutes.md"), "utf-8");
    const ops = readFileSync(path.join(runDir, "minutes.ops.jsonl"), "utf-8").trim().split("\n");

    expect(state.sections).toHaveLength(1);
    expect(markdown).toContain("### Announcements");
    expect(markdown).toContain("TODO(Cooper Thompson)");
    expect(ops).toHaveLength(2);
    expect(JSON.parse(ops[1] ?? "{}")).toMatchObject({
      op: "append_todo",
      assignee: "Cooper Thompson",
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
