#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  findActiveRun,
  fetchTranscriptMd,
  fetchMeetingRun,
  type MeterClient,
} from "./api-client";
import { createTracker, processResponse, type CursorTracker } from "./diff-tracker";
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
  claudeModel: string | null;
  claudeEffort: "low" | "medium" | "high" | "max" | null;
}

interface RunMetadata {
  meeting_id: string | null;
  meeting_run_id: string;
  room_id: string;
  base_url: string;
  prompt_label?: string | null;
  claude_model?: string | null;
  claude_effort?: "low" | "medium" | "high" | "max" | null;
}

interface InjectedMinuteTakerConfig {
  prompt_label?: string | null;
  user_prompt_body?: string | null;
  user_final_prompt_body?: string | null;
  claude_model?: string | null;
  claude_effort?: "low" | "medium" | "high" | "max" | null;
  reset_output?: boolean;
  tmux_session?: string | null;
}

function readInjectedConfig(): InjectedMinuteTakerConfig {
  const encoded = process.env.METER_MINUTE_TAKER_CONFIG_B64?.trim();
  if (!encoded) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as InjectedMinuteTakerConfig;
  } catch (error) {
    throw new Error(`Invalid METER_MINUTE_TAKER_CONFIG_B64: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    claudeModel: args.get("--claude-model")?.trim() || process.env.METER_MINUTE_TAKER_MODEL?.trim() || null,
    claudeEffort: (() => {
      const effort = args.get("--claude-effort")?.trim() || process.env.METER_MINUTE_TAKER_EFFORT?.trim() || null;
      return effort && ["low", "medium", "high", "max"].includes(effort)
        ? effort as Config["claudeEffort"]
        : null;
    })(),
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

function extractZoomMeetingId(roomId: string): string | null {
  return roomId.startsWith("zoom:") ? roomId.slice(5) : null;
}

async function writeChunk(runDir: string, segmentIndex: number, content: string): Promise<void> {
  const chunkDir = `${runDir}/chunks`;
  mkdirSync(chunkDir, { recursive: true });
  const filename = `${chunkDir}/${String(segmentIndex).padStart(4, "0")}.md`;
  await Bun.write(filename, content);
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
  injectedConfig: InjectedMinuteTakerConfig,
  tracker: CursorTracker,
  tmux: TmuxSession,
): Promise<void> {
  let consecutiveErrors = 0;
  let pollCount = 0;

  while (true) {
    pollCount++;
    let shouldExit = false;

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
          const msg = buildFinalMessage(chunk, injectedConfig.user_final_prompt_body ?? null);
          await pasteMessage(tmux, msg);
        } else {
          const msg = buildFinalMessage(null, injectedConfig.user_final_prompt_body ?? null);
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
        shouldExit = true;
      } else {
        // Fetch transcript since last cursor
        const sinceParam = tracker.cursor ?? undefined;
        console.log(`Poll ${pollCount}: fetching transcript (since=${sinceParam ?? "start"})...`);
        const response = await fetchTranscriptMd(client, runId, sinceParam);
        console.log(`  Response: ${response.length} bytes`);
        const chunk = processResponse(tracker, response);

        if (!chunk) {
          console.log("  No new content.");
        } else {
          console.log(
            `Chunk ${chunk.segmentIndex}: ${chunk.content.split("\n").length} lines (cursor: ${chunk.cursor ?? "none"})`,
          );

          // Save chunk to disk for audit trail
          await writeChunk(runDir, chunk.segmentIndex, chunk.content);

          // Paste chunk content directly into Claude's conversation
          const msg = formatChunkMessage(chunk);
          await pasteMessage(tmux, msg);

          consecutiveErrors = 0;
        }
      }
    } catch (error) {
      consecutiveErrors++;
      console.error(`Poll error (${consecutiveErrors}/10):`, error);
      if (consecutiveErrors >= 10) {
        console.error("Too many consecutive errors, exiting.");
        shouldExit = true;
      }
    }

    if (shouldExit) {
      break;
    }

    await sleep(config.pollIntervalMs);
  }
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));
  const injectedConfig = readInjectedConfig();
  const client: MeterClient = { baseUrl: config.baseUrl };

  // Resolve meeting run ID
  const runId = await resolveRunId(client, config);
  const meetingRun = await fetchMeetingRun(client, runId);
  const meetingId = config.meetingId ?? extractZoomMeetingId(meetingRun.room_id) ?? runId;

  // Per-run directory: minutes/{meeting_run_id}/
  const runDir = resolve(config.minutesRoot, runId);
  mkdirSync(`${runDir}/chunks`, { recursive: true });
  const metadata: RunMetadata = {
    meeting_id: meetingId,
    meeting_run_id: runId,
    room_id: meetingRun.room_id,
    base_url: config.baseUrl,
    prompt_label: injectedConfig.prompt_label ?? null,
    claude_model: injectedConfig.claude_model?.trim() || config.claudeModel,
    claude_effort: injectedConfig.claude_effort?.trim() || config.claudeEffort,
  };
  if (injectedConfig.reset_output) {
    rmSync(`${runDir}/minutes.md`, { force: true });
    rmSync(`${runDir}/chunks`, { recursive: true, force: true });
    rmSync(`${runDir}/.system-prompt.txt`, { force: true });
    rmSync(`${runDir}/.launch-claude.sh`, { force: true });
    rmSync(`${runDir}/.user-prompt.txt`, { force: true });
    rmSync(`${runDir}/.final-user-prompt.txt`, { force: true });
    mkdirSync(`${runDir}/chunks`, { recursive: true });
  }
  await Bun.write(`${runDir}/run.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Run directory: ${runDir}`);

  // Default tmux session name
  config.tmuxSession = injectedConfig.tmux_session?.trim() || config.tmuxSession;
  if (!config.tmuxSession) {
    config.tmuxSession = `minutes-${runId}`;
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
  await Bun.write(`${runDir}/.user-prompt.txt`, `${injectedConfig.user_prompt_body?.trim() ?? ""}\n`);
  await Bun.write(`${runDir}/.final-user-prompt.txt`, `${injectedConfig.user_final_prompt_body?.trim() ?? ""}\n`);
  const systemPrompt = buildSystemPrompt({
    meetingId,
    meetingRunId: runId,
    userPromptBody: injectedConfig.user_prompt_body ?? null,
  });
  await launchClaude(tmux, systemPrompt, {
    model: metadata.claude_model,
    effort: metadata.claude_effort,
  });
  console.log("Launched Claude in tmux session. Waiting for initialization...");
  await sleep(2000);

  // Send initial orientation prompt
  await sendMessage(tmux, buildInitialPrompt());

  console.log(`Polling every ${config.pollIntervalMs / 1000}s...`);
  console.log(`Attach to session: tmux attach -t ${config.tmuxSession}`);
  console.log(`Output: ${runDir}/minutes.md`);
  console.log(`Preview: bun run minute-taker/preview.ts --meeting-run-id ${runId}`);
  console.log("");

  // Run the polling loop
  const tracker = createTracker();
  await runPollingLoop(client, config, runId, runDir, injectedConfig, tracker, tmux);

  console.log("Minute-taker finished.");
  await shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
