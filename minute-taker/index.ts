#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findActiveRun,
  fetchAttendees,
  fetchTranscriptMd,
  fetchAttendeesMd,
  fetchMeetingRun,
  type MeterClient,
} from "./api-client";
import { createTracker, processResponse, type CursorTracker } from "./diff-tracker";
import {
  initializeMinutesStore,
  syncAttendeesIntoMinutesState,
  syncRenderedMinutes,
  type MinutesStorePaths,
} from "./store";
import { createSession, killSession, launchClaude, pasteMessage, sendMessage, type TmuxSession } from "./tmux";
import {
  buildSystemPrompt,
  buildInitialPrompt,
  formatChunkMessage,
  buildFinalMessage,
} from "./prompt";

interface Config {
  meetingId: string | null;
  meetingRunId: string | null;
  baseUrl: string;
  pollIntervalMs: number;
  finalizationTimeoutMs: number;
  finalizationSettleMs: number;
  minutesRoot: string;
  tmuxSession: string;
}

function parseArgs(argv: string[]): Config {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, next);
    i++;
  }

  const meetingId = args.get("--meeting-id") ?? null;
  const meetingRunId = args.get("--meeting-run-id") ?? null;
  if (!meetingId && !meetingRunId) {
    console.error("Usage: bun run minute-taker/index.ts --meeting-id <zoom-id> | --meeting-run-id <uuid>");
    console.error("  --base-url <url>        Meter API (default: http://127.0.0.1:3100)");
    console.error("  --poll-interval <sec>   Polling interval in seconds (default: 15)");
    console.error("  --minutes-root <path>   Root for all minutes dirs (default: ./minutes)");
    process.exit(1);
  }

  return {
    meetingId,
    meetingRunId,
    baseUrl: args.get("--base-url") ?? "http://127.0.0.1:3100",
    pollIntervalMs: parseInt(args.get("--poll-interval") ?? "15", 10) * 1000,
    finalizationTimeoutMs: parseInt(args.get("--final-timeout") ?? "120", 10) * 1000,
    finalizationSettleMs: parseInt(args.get("--final-settle") ?? "8", 10) * 1000,
    minutesRoot: resolve(args.get("--minutes-root") ?? "./minutes"),
    tmuxSession: args.get("--tmux-session") ?? "", // resolved later
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveRunId(client: MeterClient, config: Config): Promise<string> {
  if (config.meetingRunId) {
    await fetchMeetingRun(client, config.meetingRunId);
    return config.meetingRunId;
  }

  console.log(`Looking for active capture of Zoom meeting ${config.meetingId}...`);
  const timeoutMs = 5 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const run = await findActiveRun(client, config.meetingId!);
    if (run) {
      console.log(`Found active run: ${run.meeting_run_id} (${run.room_id})`);
      return run.meeting_run_id;
    }
    console.log("  No active capture found, retrying in 5s...");
    await sleep(5000);
  }

  throw new Error(`Timed out waiting for an active capture of meeting ${config.meetingId}`);
}

async function writeChunk(runDir: string, segmentIndex: number, content: string): Promise<void> {
  const chunkDir = `${runDir}/chunks`;
  mkdirSync(chunkDir, { recursive: true });
  const filename = `${chunkDir}/${String(segmentIndex).padStart(4, "0")}.md`;
  await Bun.write(filename, content);
}

function writeMinuteOpLauncher(runDir: string): string {
  const launcherPath = `${runDir}/minute-op`;
  const cliPath = resolve(dirname(import.meta.path), "op-cli.ts");
  writeFileSync(
    launcherPath,
    `#!/bin/bash\nset -euo pipefail\nexec bun run ${JSON.stringify(cliPath)} \"$@\"\n`,
  );
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}

interface MinutesSnapshot {
  exists: boolean;
  content: string | null;
  mtimeMs: number;
}

function readMinutesSnapshot(runDir: string): MinutesSnapshot {
  const minutesPath = `${runDir}/minutes.md`;
  if (!existsSync(minutesPath)) {
    return {
      exists: false,
      content: null,
      mtimeMs: 0,
    };
  }
  return {
    exists: true,
    content: readFileSync(minutesPath, "utf-8"),
    mtimeMs: statSync(minutesPath).mtimeMs,
  };
}

async function waitForMinutesSettled(
  runDir: string,
  baseline: MinutesSnapshot,
  timeoutMs: number,
  settleMs: number,
): Promise<"settled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = baseline;
  let lastChangeAt: number | null = null;

  while (Date.now() < deadline) {
    const snapshot = readMinutesSnapshot(runDir);
    const changed = snapshot.exists !== lastSnapshot.exists
      || snapshot.mtimeMs !== lastSnapshot.mtimeMs
      || snapshot.content !== lastSnapshot.content;
    if (changed) {
      lastSnapshot = snapshot;
      lastChangeAt = Date.now();
    }
    if (lastChangeAt !== null && Date.now() - lastChangeAt >= settleMs) {
      return "settled";
    }
    await sleep(1000);
  }

  return "timeout";
}

async function runPollingLoop(
  client: MeterClient,
  config: Config,
  runId: string,
  runDir: string,
  storePaths: MinutesStorePaths,
  tracker: CursorTracker,
  tmux: TmuxSession,
): Promise<void> {
  let consecutiveErrors = 0;
  let pollCount = 0;

  while (true) {
    await sleep(config.pollIntervalMs);
    pollCount++;

    try {
      // Check meeting state
      const run = await fetchMeetingRun(client, runId);
      if (["completed", "failed", "aborted"].includes(run.state)) {
        console.log(`Meeting ended (state: ${run.state}). Sending final nudge...`);
        const baselineSnapshot = readMinutesSnapshot(runDir);
        const response = await fetchTranscriptMd(client, runId, tracker.cursor ?? undefined);
        const chunk = processResponse(tracker, response);
        if (chunk) {
          await writeChunk(runDir, chunk.segmentIndex, chunk.content);
          const msg = buildFinalMessage(chunk);
          await pasteMessage(tmux, msg);
        } else {
          const msg = buildFinalMessage(null);
          await sendMessage(tmux, msg);
        }
        console.log("Waiting for minutes.md to update and settle...");
        const finalizationResult = await waitForMinutesSettled(
          runDir,
          baselineSnapshot,
          config.finalizationTimeoutMs,
          config.finalizationSettleMs,
        );
        if (finalizationResult === "timeout") {
          console.log("Finalization timed out waiting for a settled minutes.md update.");
        } else {
          console.log("minutes.md updated and settled.");
        }
        break;
      }

      // Fetch transcript since last cursor
      const sinceParam = tracker.cursor ?? undefined;
      console.log(`Poll ${pollCount}: fetching transcript (since=${sinceParam ?? "start"})...`);
      const response = await fetchTranscriptMd(client, runId, sinceParam);
      console.log(`  Response: ${response.length} bytes`);
      const chunk = processResponse(tracker, response);

      if (!chunk) {
        syncRenderedMinutes(runDir);
        console.log(`  No new content.`);
        continue;
      }

      console.log(
        `Chunk ${chunk.segmentIndex}: ${chunk.content.split("\n").length} lines (cursor: ${chunk.cursor ?? "none"})`,
      );

      // Save chunk to disk for audit trail
      await writeChunk(runDir, chunk.segmentIndex, chunk.content);

      // Refresh attendees every 5th poll
      if (pollCount % 5 === 0) {
        try {
          const attendeeItems = await fetchAttendees(client, runId);
          syncAttendeesIntoMinutesState(runDir, attendeeItems);
          const attendees = await fetchAttendeesMd(client, runId);
          await Bun.write(storePaths.attendeesPath, attendees);
        } catch {
          // Non-critical
        }
      }

      // Paste chunk content directly into Claude's conversation
      const msg = formatChunkMessage(chunk);
      await pasteMessage(tmux, msg);
      syncRenderedMinutes(runDir);

      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      console.error(`Poll error (${consecutiveErrors}/10):`, error);
      if (consecutiveErrors >= 10) {
        console.error("Too many consecutive errors, exiting.");
        break;
      }
    }
  }
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));
  const client: MeterClient = { baseUrl: config.baseUrl };

  // Resolve meeting run ID
  const runId = await resolveRunId(client, config);
  const run = await fetchMeetingRun(client, runId);
  const meetingId = config.meetingId ?? (run.room_id.startsWith("zoom:") ? run.room_id.slice(5) : runId);
  const shortRunId = runId.slice(0, 8);

  // Per-run directory: minutes/{meetingId}-{shortRunId}/
  const runDirName = `${meetingId}-${shortRunId}`;
  const runDir = resolve(config.minutesRoot, runDirName);
  mkdirSync(`${runDir}/chunks`, { recursive: true });
  console.log(`Run directory: ${runDir}`);
  const storePaths = initializeMinutesStore(runDir, {
    meetingId,
    meetingRunId: runId,
    title: run.room_id,
    startedAt: run.started_at ?? run.created_at ?? null,
    status: ["completed", "failed", "aborted"].includes(run.state)
      ? run.state
      : "live",
  });
  const launcherPath = writeMinuteOpLauncher(runDir);
  console.log(`Minute op CLI: ${launcherPath}`);

  // Default tmux session name
  if (!config.tmuxSession) {
    config.tmuxSession = `minutes-${meetingId}-${shortRunId}`;
  }

  // Fetch initial attendees
  try {
    const attendeeItems = await fetchAttendees(client, runId);
    syncAttendeesIntoMinutesState(runDir, attendeeItems);
    const attendees = await fetchAttendeesMd(client, runId);
    await Bun.write(storePaths.attendeesPath, attendees);
    console.log("Fetched initial attendees.");
  } catch {
    console.log("Could not fetch attendees (meeting may still be starting).");
  }

  // Create tmux session with run dir as cwd
  const tmux = await createSession(config.tmuxSession, runDir);
  console.log(`Created tmux session "${config.tmuxSession}"`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    try {
      await killSession(tmux);
    } catch {
      // Session may already be gone
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Launch Claude with run dir as cwd -- prompts use relative paths
  const systemPrompt = buildSystemPrompt({ meetingId, meetingRunId: runId });
  await launchClaude(tmux, systemPrompt);
  console.log("Launched Claude in tmux session. Waiting for initialization...");
  await sleep(5000);

  // Send initial orientation prompt
  await sendMessage(tmux, buildInitialPrompt());

  console.log(`Polling every ${config.pollIntervalMs / 1000}s...`);
  console.log(`Attach to session: tmux attach -t ${config.tmuxSession}`);
  console.log(`Output: ${runDir}/minutes.md`);
  console.log(`Preview: bun run minute-taker/preview.ts --meeting-id ${meetingId}`);
  console.log("");

  // Run the polling loop
  const tracker = createTracker();
  await runPollingLoop(client, config, runId, runDir, storePaths, tracker, tmux);

  console.log("Minute-taker finished.");
  await shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
