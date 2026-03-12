import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { initializeMinutesStore } from "./store";

test("minute-op submit validates and appends an operation", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "meter-minute-cli-"));
  try {
    initializeMinutesStore(runDir, {
      meetingId: "999001",
      meetingRunId: "019ce326",
      title: "FHIR-I WG Call",
      startedAt: "2026-03-12T17:45:06.262Z",
      status: "live",
    });

    const proc = Bun.spawn(
      ["bun", "run", "minute-taker/op-cli.ts", "submit", "--run-dir", runDir],
      {
        cwd: path.resolve("."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(
      JSON.stringify({
        op: "upsert_section",
        sectionId: "announcements",
        title: "Announcements",
      }),
    );
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("\"ok\": true");
    expect(readFileSync(path.join(runDir, "minutes.ops.jsonl"), "utf-8")).toContain("\"op\":\"upsert_section\"");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("minute-op submit returns a zod error for invalid input", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "meter-minute-cli-"));
  try {
    initializeMinutesStore(runDir, {
      meetingId: "999001",
      meetingRunId: "019ce326",
      title: "FHIR-I WG Call",
      startedAt: "2026-03-12T17:45:06.262Z",
      status: "live",
    });

    const proc = Bun.spawn(
      ["bun", "run", "minute-taker/op-cli.ts", "submit", "--run-dir", runDir],
      {
        cwd: path.resolve("."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(
      JSON.stringify({
        op: "append_todo",
        text: "Missing sectionId should fail",
      }),
    );
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("\"name\": \"ZodError\"");
    expect(stderr).toContain("\"sectionId\"");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
