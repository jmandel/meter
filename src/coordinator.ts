import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";

import dashboard from "../ui/index.html";
import minutesView from "../ui/minutes-view.html";

import type {
  AttendeeSummaryRecord,
  AppendEventsBatchRequest,
  AppConfig,
  ChatMessageRecord,
  CompleteMeetingRunRequest,
  CreateMeetingRunRequest,
  EventEnvelope,
  EventRecord,
  HealthResponse,
  InternalConfig,
  ListResponse,
  MeetingRunOptions,
  MeetingRunRecord,
  OperatorAssistancePayload,
  RescueClaimRequest,
  RescueReleaseRequest,
  RescueStatusResponse,
  SearchHit,
  SpeechSegmentRecord,
  StartSimulationRequest,
  StartSimulationResponse,
  WorkerLaunchConfig,
  WorkerHeartbeatResponse,
  WorkerRegisterRequest,
  AudioCaptureStartedPayload,
  AudioCaptureStoppedPayload,
  BrowserConsolePayload,
  MinuteJobRecord,
  MinutePromptConfig,
  MinuteVersionRecord,
  RestartMinuteJobRequest,
  StartMinuteJobRequest,
  StopMinuteJobRequest,
  TranscriptionSegmentPayload,
  TranscriptionSessionStartedPayload,
  ZoomChatMessagePayload,
  ZoomMeetingJoinedPayload,
  ZoomSpeakerActivePayload,
  ZoomAttendeePresencePayload,
} from "./domain";
import { AppDatabase } from "./database";
import {
  buildLifecycleFile,
  createMeetingRunLayout,
  ensureCoordinatorLayout,
  type MeetingRunFileLayout,
  writeMeetingLifecycle,
  writeMeetingMetadata,
} from "./files";
import {
  appendLogLine,
  encodeBase64Json,
  errorResponse,
  jsonResponse,
  nowUnixMs,
  parseBoolean,
  parseInteger,
  parseJsonBody,
  parseTimestamp,
  randomToken,
  uuidv7,
} from "./utils";
import { parseSimulationScript, type SimulationScenario, type SimulationStep } from "./simulation";
import { normalizeZoomJoinUrl } from "./zoom";

interface WorkerHandle {
  meeting_run_id: string;
  worker_id: string | null;
  browser_token: string;
  stop_requested: boolean;
  completed: boolean;
  child: Bun.Subprocess<"ignore", "ignore", "inherit"> | null;
  child_pid: number | null;
}

interface RescueClaimState {
  claimed: boolean;
  operator: string | null;
  reason: string | null;
  note: string | null;
  claimed_at_unix_ms: number | null;
  released_at_unix_ms: number | null;
}

interface AutomatedRescueRuntimeConfig {
  enabled: boolean;
  command: string | null;
  timeout_ms: number;
  cooldown_ms: number;
  max_attempts: number;
  operator_name: string;
  repo_root: string;
}

interface AutomatedRescueAttempt {
  meeting_run_id: string;
  attempt_number: number;
  reason: string;
  started_at_unix_ms: number;
  child: ChildProcessWithoutNullStreams | null;
  timeout: Timer | null;
  log_path: string;
  prompt_path: string;
  context_path: string;
}

interface SimulationHandle {
  meeting_run_id: string;
  room_id: string;
  cancelled: boolean;
  completed: boolean;
  cancel_reason: string | null;
  abort_controller: AbortController;
  promise: Promise<void> | null;
}

interface MinuteJobHandle {
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  tmux_session_name: string;
  working_dir: string;
  latest_minutes_path: string;
  stop_requested: boolean;
  completed: boolean;
  child: Bun.Subprocess<"ignore", "ignore", "inherit"> | null;
  child_pid: number | null;
  watcher: FSWatcher | null;
  debounce_timer: Timer | null;
}

interface SseSubscriber {
  send(record: EventRecord): void;
  matches(record: EventRecord): boolean;
  close(): void;
}

interface MinuteSnapshotUpdate {
  meeting_run_id: string;
  room_id: string;
  minute_job: MinuteJobRecord;
  version: MinuteVersionRecord;
  content_markdown: string;
}

interface MinuteSubscriber {
  send(update: MinuteSnapshotUpdate): void;
  matches(update: MinuteSnapshotUpdate): boolean;
  close(): void;
}

type TranscriptIncludeKind = "speech" | "chat" | "joins";

class EventBus {
  private subscribers = new Set<SseSubscriber>();

  publish(records: EventRecord[]): void {
    for (const record of records) {
      for (const subscriber of this.subscribers) {
        if (subscriber.matches(record)) {
          subscriber.send(record);
        }
      }
    }
  }

  subscribe(subscriber: SseSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      subscriber.close();
    };
  }
}

class MinutesBus {
  private subscribers = new Set<MinuteSubscriber>();

  publish(update: MinuteSnapshotUpdate): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.matches(update)) {
        subscriber.send(update);
      }
    }
  }

  subscribe(subscriber: MinuteSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      subscriber.close();
    };
  }
}

function buildMeetingRunOptions(config: AppConfig, overrides?: Partial<MeetingRunOptions>): MeetingRunOptions {
  return {
    open_chat_panel: true,
    enable_transcription: config.transcription_provider !== "none",
    enable_speaker_tracking: true,
    enable_chat_tracking: true,
    persist_archive_audio: config.persist_archive_audio,
    persist_live_pcm: config.persist_live_pcm,
    archive_chunk_ms: config.archive_chunk_ms,
    live_pcm_chunk_ms: config.live_pcm_chunk_ms,
    auto_stop_when_meeting_ends: true,
    ...overrides,
  };
}

function formatRoomLabel(roomId: string): string {
  const [provider, providerRoomKey] = roomId.split(":", 2);
  if (provider === "zoom" && providerRoomKey) {
    return `Zoom ${providerRoomKey}`;
  }
  return roomId;
}

async function serveFileContent(request: Request, filePath: string, contentType: string | null): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return errorResponse(404, "not_found", "File not found");
  }

  const rangeHeader = request.headers.get("range");
  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("content-type", contentType ?? file.type ?? "application/octet-stream");

  if (!rangeHeader) {
    return new Response(file, {
      status: 200,
      headers,
    });
  }

  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return errorResponse(416, "invalid_range", "Unsupported Range header");
  }
  const size = file.size;
  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= size) {
    return errorResponse(416, "invalid_range", "Requested range is not satisfiable");
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers,
  });
}

export class CoordinatorApp {
  private storage!: AppDatabase;
  private readonly eventBus = new EventBus();
  private readonly minutesBus = new MinutesBus();
  private readonly workersByMeetingRunId = new Map<string, WorkerHandle>();
  private readonly workersByWorkerId = new Map<string, WorkerHandle>();
  private readonly minuteJobsByMeetingRunId = new Map<string, MinuteJobHandle>();
  private readonly minuteJobsByMinuteJobId = new Map<string, MinuteJobHandle>();
  private readonly simulationsByMeetingRunId = new Map<string, SimulationHandle>();
  private readonly rescueClaimsByMeetingRunId = new Map<string, RescueClaimState>();
  private readonly automatedRescueAttemptsByMeetingRunId = new Map<string, AutomatedRescueAttempt>();
  private readonly automatedRescueAttemptCountsByMeetingRunId = new Map<string, number>();
  private readonly automatedRescueLastAttemptByMeetingRunId = new Map<string, number>();
  private readonly automatedRescueConfig: AutomatedRescueRuntimeConfig;
  private server?: Bun.Server;
  private coordinatorLogPath = "";
  private stopPromise: Promise<void> | null = null;
  private rescuePromptTemplatePromise: Promise<string> | null = null;

  constructor(private readonly config: InternalConfig) {
    this.automatedRescueConfig = this.loadAutomatedRescueConfig();
  }

  private loadAutomatedRescueConfig(): AutomatedRescueRuntimeConfig {
    const command = process.env.METER_AUTOMATED_RESCUE_COMMAND?.trim() || null;
    const enabled = Boolean(command) && parseBoolean(process.env.METER_AUTOMATED_RESCUE_ENABLED, true);
    return {
      enabled,
      command,
      timeout_ms: parseInteger(process.env.METER_AUTOMATED_RESCUE_TIMEOUT_MS ?? null, 10 * 60 * 1000),
      cooldown_ms: parseInteger(process.env.METER_AUTOMATED_RESCUE_COOLDOWN_MS ?? null, 5 * 60 * 1000),
      max_attempts: parseInteger(process.env.METER_AUTOMATED_RESCUE_MAX_ATTEMPTS ?? null, 1),
      operator_name: process.env.METER_AUTOMATED_RESCUE_OPERATOR?.trim() || "automated-rescue",
      repo_root: path.resolve(new URL("..", import.meta.url).pathname),
    };
  }

  async start(): Promise<void> {
    const layout = await ensureCoordinatorLayout(this.config.data_root);
    this.coordinatorLogPath = layout.coordinator_log_path;
    this.storage = new AppDatabase(this.config);
    this.storage.init();
    await this.reconcileRecoveredMeetingRuns();
    await this.reconcileRecoveredMinuteJobs();
    this.server = Bun.serve({
      hostname: this.config.listen_host,
      port: this.config.listen_port,
      routes: {
        "/": dashboard,
        "/minutes-view": minutesView,
      },
      fetch: (request) => this.handleRequest(request),
    });
    await appendLogLine(this.coordinatorLogPath, `listening on ${this.config.listen_host}:${this.server.port}`);
    console.log(`[api] Listening on http://${this.config.listen_host}:${this.server.port}`);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    this.stopPromise = this.stopInternal();
    await this.stopPromise;
  }

  private async reconcileRecoveredMeetingRuns(): Promise<void> {
    const now = nowUnixMs();
    const staleRuns = this.storage.listRecoverableMeetingRuns(10_000);
    for (const run of staleRuns) {
      const message = `Meter started with no live worker for prior ${run.state} run`;
      this.storage.patchMeetingRun(run.meeting_run_id, {
        state: "aborted",
        ended_at_unix_ms: now,
        worker_id: null,
        worker_pid: null,
        ingest_port: null,
        cdp_port: null,
        updated_at_unix_ms: now,
        last_error_code: run.last_error?.code ?? "startup_recovery",
        last_error_message: run.last_error?.message ?? message,
      });
      await appendLogLine(this.coordinatorLogPath, `recovered stale run ${run.meeting_run_id} -> aborted`);
    }
  }

  private async reconcileRecoveredMinuteJobs(): Promise<void> {
    const now = nowUnixMs();
    const staleJobs = this.storage.listRecoverableMinuteJobs(10_000);
    for (const job of staleJobs) {
      this.storage.patchMinuteJob(job.minute_job_id, {
        state: "failed",
        ended_at_unix_ms: now,
        last_error_code: job.last_error?.code ?? "startup_recovery",
        last_error_message: job.last_error?.message ?? "Meter started with no live minute-taker process",
      });
      await appendLogLine(this.coordinatorLogPath, `recovered stale minute job ${job.minute_job_id} -> failed`);
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/health" && request.method === "GET") {
        return this.handleHealth(request);
      }
      if (url.pathname === "/v1/meeting-runs" && request.method === "POST") {
        return await this.handleCreateMeetingRun(request);
      }
      if (url.pathname === "/v1/meeting-runs" && request.method === "GET") {
        return this.handleListMeetingRuns(url);
      }
      if (url.pathname === "/v1/events" && request.method === "GET") {
        return this.handleListEvents(url);
      }
      if (url.pathname === "/v1/speech" && request.method === "GET") {
        return this.handleListSpeech(url);
      }
      if (url.pathname === "/v1/chat" && request.method === "GET") {
        return this.handleListChat(url);
      }
      if (url.pathname === "/v1/rooms" && request.method === "GET") {
        return this.handleListRooms(url);
      }
      if (url.pathname === "/v1/search" && request.method === "GET") {
        return this.handleSearch(url);
      }
      if (url.pathname === "/v1/simulations" && request.method === "POST") {
        return await this.handleStartSimulation(request);
      }
      if (url.pathname === "/v1/stream" && request.method === "GET") {
        return this.handleEventStream(request, { room_id: url.searchParams.get("room_id"), meeting_run_id: url.searchParams.get("meeting_run_id"), kind: url.searchParams.get("kind"), source: url.searchParams.get("source") });
      }

      let match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)$/);
      if (match && request.method === "GET") {
        return this.handleGetZoomMeeting(match[1], url);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/meeting-runs$/);
      if (match && request.method === "GET") {
        return this.handleListMeetingRuns(url, this.zoomRoomIdFromMeetingId(match[1]));
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/transcript\.md$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingTranscript(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/minutes$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingMinutes(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/minutes\/view$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingMinutesView(request, url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/minutes\.md$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingMinutesMarkdown(url, match[1], request);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/minutes\/stream$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingMinutesStream(request, url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/attendees$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingAttendees(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/attendees\.md$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingMarkdownAttendees(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/zoom-meetings\/([^/]+)\/stream$/);
      if (match && request.method === "GET") {
        return this.handleZoomMeetingStream(request, url, match[1]);
      }

      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)$/);
      if (match && request.method === "GET") {
        return this.handleGetMeetingRun(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/stop$/);
      if (match && request.method === "POST") {
        return this.handleStopMeetingRun(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/events$/);
      if (match && request.method === "GET") {
        return this.handleListEvents(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/speech$/);
      if (match && request.method === "GET") {
        return this.handleListSpeech(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/transcript\.md$/);
      if (match && request.method === "GET") {
        return this.handleMarkdownTranscript(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes$/);
      if (match && request.method === "GET") {
        return this.handleGetMinutes(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/view$/);
      if (match && request.method === "GET") {
        return this.handleMinutesView(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/start$/);
      if (match && request.method === "POST") {
        return await this.handleStartMinutes(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/restart$/);
      if (match && request.method === "POST") {
        return await this.handleRestartMinutes(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/stop$/);
      if (match && request.method === "POST") {
        return await this.handleStopMinutes(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\.md$/);
      if (match && request.method === "GET") {
        return this.handleMinutesMarkdown(match[1], request);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/versions$/);
      if (match && request.method === "GET") {
        return this.handleListMinuteVersions(match[1], url);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/minutes\/stream$/);
      if (match && request.method === "GET") {
        return this.handleMinuteStream(request, { meeting_run_id: match[1], room_id: null });
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/rescue$/);
      if (match && request.method === "GET") {
        return this.handleGetRescueStatus(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/rescue\/claim$/);
      if (match && request.method === "POST") {
        return await this.handleRescueClaim(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/rescue\/release$/);
      if (match && request.method === "POST") {
        return await this.handleRescueRelease(request, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/attendees$/);
      if (match && request.method === "GET") {
        return this.handleListAttendees(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/attendees\.md$/);
      if (match && request.method === "GET") {
        return this.handleMarkdownAttendees(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/chat$/);
      if (match && request.method === "GET") {
        return this.handleListChat(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/speakers$/);
      if (match && request.method === "GET") {
        return this.handleListSpeakers(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/screenshot$/);
      if (match && request.method === "GET") {
        return await this.handleScreenshot(match[1]);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/audio$/);
      if (match && request.method === "GET") {
        return this.handleListAudio(url, match[1], request);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/artifacts$/);
      if (match && request.method === "GET") {
        return this.handleListArtifacts(url, match[1], request);
      }
      match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)\/stream$/);
      if (match && request.method === "GET") {
        return this.handleEventStream(request, { meeting_run_id: match[1], room_id: null, kind: url.searchParams.get("kind"), source: url.searchParams.get("source") });
      }
      match = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/meeting-runs$/);
      if (match && request.method === "GET") {
        return this.handleListMeetingRuns(url, match[1]);
      }
      match = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/stream$/);
      if (match && request.method === "GET") {
        return this.handleEventStream(request, { room_id: match[1], meeting_run_id: null, kind: url.searchParams.get("kind"), source: url.searchParams.get("source") });
      }
      match = url.pathname.match(/^\/v1\/audio-objects\/([^/]+)$/);
      if (match && request.method === "GET") {
        return this.handleGetAudioObject(match[1], request);
      }
      match = url.pathname.match(/^\/v1\/audio-objects\/([^/]+)\/content$/);
      if (match && request.method === "GET") {
        return this.handleAudioContent(match[1], request);
      }
      match = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/content$/);
      if (match && request.method === "GET") {
        return this.handleArtifactContent(match[1], request);
      }

      if (url.pathname === "/internal/v1/workers/register" && request.method === "POST") {
        return await this.handleWorkerRegister(request);
      }
      match = url.pathname.match(/^\/internal\/v1\/workers\/([^/]+)\/heartbeat$/);
      if (match && request.method === "POST") {
        return await this.handleWorkerHeartbeat(request, match[1]);
      }
      match = url.pathname.match(/^\/internal\/v1\/meeting-runs\/([^/]+)\/events:batch$/);
      if (match && request.method === "POST") {
        return await this.handleAppendEvents(request, match[1]);
      }
      match = url.pathname.match(/^\/internal\/v1\/meeting-runs\/([^/]+)\/complete$/);
      if (match && request.method === "POST") {
        return await this.handleWorkerComplete(request, match[1]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLogLine(this.coordinatorLogPath, `error ${request.method} ${url.pathname}: ${message}`);
      return errorResponse(500, "internal_error", "Unhandled server error", { message });
    }

    return errorResponse(404, "not_found", `No route for ${request.method} ${url.pathname}`);
  }

  private resolvePublicBaseUrl(request: Request): string {
    return this.config.public_base_url || new URL(request.url).origin;
  }

  private async stopInternal(): Promise<void> {
    const activeHandles = Array.from(this.workersByMeetingRunId.values()).filter((handle) => !handle.completed);
    const activeMinuteHandles = Array.from(this.minuteJobsByMeetingRunId.values()).filter((handle) => !handle.completed);
    for (const handle of activeHandles) {
      handle.stop_requested = true;
    }
    for (const handle of activeMinuteHandles) {
      handle.stop_requested = true;
    }
    await this.persistWorkersState();
    await Promise.allSettled([
      ...activeHandles.map((handle) => this.terminateWorker(handle)),
      ...activeMinuteHandles.map((handle) => this.terminateMinuteJob(handle)),
      ...Array.from(this.automatedRescueAttemptsByMeetingRunId.keys()).map((meetingRunId) =>
        this.stopAutomatedRescueForMeetingRun(meetingRunId, "coordinator stopping"),
      ),
      ...Array.from(this.simulationsByMeetingRunId.keys()).map((meetingRunId) =>
        this.stopSimulationForMeetingRun(meetingRunId, "coordinator stopping"),
      ),
    ]);
    this.server?.stop();
    this.storage.close();
  }

  private async terminateWorker(handle: WorkerHandle): Promise<void> {
    const pid = handle.child?.pid ?? handle.child_pid;
    if (!pid || !this.isProcessAlive(pid)) {
      return;
    }

    process.kill(pid, "SIGTERM");
    await Promise.race([
      handle.child?.exited ?? new Promise<number>((resolve) => setTimeout(() => resolve(0), 1500)),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 1500)),
    ]);

    if (!this.isProcessAlive(pid)) {
      return;
    }

    process.kill(pid, "SIGKILL");
    await Promise.race([
      handle.child?.exited ?? new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
    ]);
  }

  private closeMinuteJobWatcher(handle: MinuteJobHandle): void {
    if (handle.debounce_timer) {
      clearTimeout(handle.debounce_timer);
      handle.debounce_timer = null;
    }
    handle.watcher?.close();
    handle.watcher = null;
  }

  private async terminateMinuteJob(handle: MinuteJobHandle): Promise<void> {
    this.closeMinuteJobWatcher(handle);
    const pid = handle.child?.pid ?? handle.child_pid;
    if (!pid || !this.isProcessAlive(pid)) {
      return;
    }

    process.kill(pid, "SIGTERM");
    await Promise.race([
      handle.child?.exited ?? new Promise<number>((resolve) => setTimeout(() => resolve(0), 2000)),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 2000)),
    ]);

    if (!this.isProcessAlive(pid)) {
      return;
    }

    process.kill(pid, "SIGKILL");
    await Promise.race([
      handle.child?.exited ?? new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
    ]);
  }

  private scheduleMinuteSnapshot(handle: MinuteJobHandle, status: "live" | "final" = "live"): void {
    if (handle.debounce_timer) {
      clearTimeout(handle.debounce_timer);
    }
    handle.debounce_timer = setTimeout(() => {
      void this.captureMinuteSnapshot(handle, status);
    }, 750);
  }

  private async captureMinuteSnapshot(handle: MinuteJobHandle, status: "live" | "final"): Promise<void> {
    handle.debounce_timer = null;
    const currentJob = this.storage.getMinuteJobRecord(handle.minute_job_id);
    if (!currentJob || !existsSync(handle.latest_minutes_path)) {
      return;
    }
    let content: string;
    try {
      content = readFileSync(handle.latest_minutes_path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const sha = this.hashText(content);
    if (sha === currentJob.latest_content_sha256) {
      return;
    }
    const ts = nowUnixMs();
    const seq = currentJob.latest_version_seq + 1;
    this.storage.insertMinuteVersion({
      minute_version_id: uuidv7(ts),
      minute_job_id: handle.minute_job_id,
      meeting_run_id: handle.meeting_run_id,
      room_id: handle.room_id,
      seq,
      status,
      content_markdown: content,
      content_sha256: sha,
      created_at_unix_ms: ts,
    });
    const minuteJob = this.storage.getMinuteJobRecord(handle.minute_job_id);
    const version = this.storage.getLatestMinuteVersionForMinuteJob(handle.minute_job_id);
    if (!minuteJob || !version) {
      return;
    }
    const payload = {
      minute_job_id: minuteJob.minute_job_id,
      version_seq: version.seq,
      status: version.status,
      updated_at: version.created_at,
    };
    const appended = this.storage.appendEvents([
      this.buildCoordinatorEvent(handle.meeting_run_id, handle.room_id, "minutes.updated", payload, ts),
    ], ts);
    this.eventBus.publish(appended.records);
    this.minutesBus.publish({
      meeting_run_id: handle.meeting_run_id,
      room_id: handle.room_id,
      minute_job: minuteJob,
      version,
      content_markdown: content,
    });
  }

  private watchMinuteJob(handle: MinuteJobHandle): void {
    this.closeMinuteJobWatcher(handle);
    mkdirSync(handle.working_dir, { recursive: true });
    handle.watcher = watch(handle.working_dir, { persistent: false }, (_eventType, filename) => {
      if (!filename) {
        this.scheduleMinuteSnapshot(handle, "live");
        return;
      }
      const name = filename.toString();
      if (name === "minutes.md") {
        this.scheduleMinuteSnapshot(handle, "live");
      }
    });
    handle.watcher.on("error", async (error) => {
      await appendLogLine(this.coordinatorLogPath, `minute watcher error ${handle.minute_job_id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (existsSync(handle.latest_minutes_path)) {
      this.scheduleMinuteSnapshot(handle, "live");
    }
  }

  private async spawnMinuteJob(
    meetingRun: MeetingRunRecord,
    promptConfig: MinutePromptConfig,
    restartedFromMinuteJobId: string | null,
  ): Promise<MinuteJobRecord> {
    const now = nowUnixMs();
    const minuteJobId = uuidv7(now);
    const workingDir = this.minuteRunDir(meetingRun.meeting_run_id);
    mkdirSync(workingDir, { recursive: true });
    const latestMinutesPath = path.join(workingDir, "minutes.md");
    const tmuxSessionName = `minutes-${meetingRun.meeting_run_id}`;
    const promptHash = this.hashText(JSON.stringify(promptConfig));
    const entryScript = this.minuteTakerEntryScript();
    const command = `${process.execPath} ${entryScript} --meeting-run-id ${meetingRun.meeting_run_id} --base-url ${this.config.coordinator_base_url}`;

    this.storage.insertMinuteJob({
      minute_job_id: minuteJobId,
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: meetingRun.room_id,
      state: "starting",
      tmux_session_name: tmuxSessionName,
      command,
      prompt_label: promptConfig.prompt_label,
      prompt_hash: promptHash,
      user_prompt_body: promptConfig.user_prompt_body,
      user_final_prompt_body: promptConfig.user_final_prompt_body,
      working_dir: workingDir,
      latest_minutes_path: latestMinutesPath,
      started_at_unix_ms: now,
      restarted_from_minute_job_id: restartedFromMinuteJobId,
    });

    const child = Bun.spawn([process.execPath, entryScript, "--meeting-run-id", meetingRun.meeting_run_id, "--base-url", this.config.coordinator_base_url, "--minutes-root", this.minutesRootDir()], {
      cwd: this.minuteTakerWorkingDir(),
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        METER_MINUTE_TAKER_CONFIG_B64: encodeBase64Json({
          ...promptConfig,
          reset_output: true,
          tmux_session: tmuxSessionName,
        }),
      },
    });

    const handle: MinuteJobHandle = {
      minute_job_id: minuteJobId,
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: meetingRun.room_id,
      tmux_session_name: tmuxSessionName,
      working_dir: workingDir,
      latest_minutes_path: latestMinutesPath,
      stop_requested: false,
      completed: false,
      child,
      child_pid: child.pid ?? null,
      watcher: null,
      debounce_timer: null,
    };
    this.minuteJobsByMeetingRunId.set(meetingRun.meeting_run_id, handle);
    this.minuteJobsByMinuteJobId.set(minuteJobId, handle);
    this.watchMinuteJob(handle);

    this.storage.patchMinuteJob(minuteJobId, { state: "running" });
    const startTs = nowUnixMs();
    const appended = this.storage.appendEvents([
      this.buildCoordinatorEvent(meetingRun.meeting_run_id, meetingRun.room_id, restartedFromMinuteJobId ? "minutes.job.restarting" : "minutes.job.started", {
        minute_job_id: minuteJobId,
        tmux_session_name: tmuxSessionName,
        prompt_label: promptConfig.prompt_label,
      }, startTs),
    ], startTs);
    this.eventBus.publish(appended.records);

    child.exited.then(async (code) => {
      const current = this.minuteJobsByMinuteJobId.get(minuteJobId);
      if (!current || current.completed) {
        return;
      }
      current.completed = true;
      current.child = null;
      current.child_pid = null;
      this.closeMinuteJobWatcher(current);
      const exitTs = nowUnixMs();
      await this.captureMinuteSnapshot(current, "final");
      const state = current.stop_requested || code === 0 ? "completed" : "failed";
      this.storage.patchMinuteJob(minuteJobId, {
        state,
        ended_at_unix_ms: exitTs,
        last_error_code: state === "failed" ? "minute_taker_exit" : null,
        last_error_message: state === "failed" ? `Minute-taker exited with code ${code}` : null,
      });
      const kind = state === "failed" ? "minutes.job.failed" : "minutes.job.stopped";
      const exitEvent = this.storage.appendEvents([
        this.buildCoordinatorEvent(meetingRun.meeting_run_id, meetingRun.room_id, kind, {
          minute_job_id: minuteJobId,
          code,
        }, exitTs),
      ], exitTs);
      this.eventBus.publish(exitEvent.records);
      if (this.minuteJobsByMeetingRunId.get(meetingRun.meeting_run_id)?.minute_job_id === minuteJobId) {
        this.minuteJobsByMeetingRunId.delete(meetingRun.meeting_run_id);
      }
      this.minuteJobsByMinuteJobId.delete(minuteJobId);
    });

    return this.storage.getMinuteJobRecord(minuteJobId) as MinuteJobRecord;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getMeetingRun(meetingRunId: string): MeetingRunRecord | null {
    return this.storage.getMeetingRunRecord(meetingRunId);
  }

  private getLatestMinuteJob(meetingRunId: string): MinuteJobRecord | null {
    return this.storage.getLatestMinuteJobRecordForMeetingRun(meetingRunId);
  }

  private minutesRootDir(): string {
    return path.resolve(process.env.METER_MINUTES_ROOT?.trim() || path.join(this.automatedRescueConfig.repo_root, "minutes"));
  }

  private minuteRunDir(meetingRunId: string): string {
    return path.join(this.minutesRootDir(), meetingRunId);
  }

  private minuteTakerEntryScript(): string {
    return path.resolve(process.env.METER_MINUTE_TAKER_ENTRY?.trim() || new URL("../minute-taker/index.ts", import.meta.url).pathname);
  }

  private minuteTakerWorkingDir(): string {
    return path.resolve(process.env.METER_MINUTE_TAKER_CWD?.trim() || this.automatedRescueConfig.repo_root);
  }

  private hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  private buildMinutePromptConfig(input: StartMinuteJobRequest | RestartMinuteJobRequest | null | undefined): MinutePromptConfig {
    const promptLabel = input?.prompt_label?.trim() || null;
    const userPromptBody = input?.user_prompt_body?.trim() || null;
    const userFinalPromptBody = input?.user_final_prompt_body?.trim() || null;
    return {
      prompt_label: promptLabel,
      user_prompt_body: userPromptBody,
      user_final_prompt_body: userFinalPromptBody,
    };
  }

  private zoomRoomIdFromMeetingId(meetingId: string): string {
    return `zoom:${decodeURIComponent(meetingId)}`;
  }

  private resolveMeetingRunForRoom(roomId: string, explicitMeetingRunId?: string | null): MeetingRunRecord | null {
    if (explicitMeetingRunId) {
      const meetingRun = this.getMeetingRun(explicitMeetingRunId);
      if (!meetingRun || meetingRun.room_id !== roomId) {
        return null;
      }
      return meetingRun;
    }

    const meetingRuns = this.storage.listMeetingRunRecords({
      room_id: roomId,
      limit: 100,
    });
    if (meetingRuns.length === 0) {
      return null;
    }
    return meetingRuns.find((item) => !["completed", "failed", "aborted"].includes(item.state)) ?? meetingRuns[0] ?? null;
  }

  private resolveMeetingRunForZoomMeeting(meetingId: string, explicitMeetingRunId?: string | null): MeetingRunRecord | null {
    return this.resolveMeetingRunForRoom(this.zoomRoomIdFromMeetingId(meetingId), explicitMeetingRunId);
  }

  private recoverWorkerHandle(meetingRun: MeetingRunRecord, workerId: string | null): WorkerHandle | null {
    if (!workerId) {
      return null;
    }
    const existing = this.workersByWorkerId.get(workerId) ?? this.workersByMeetingRunId.get(meetingRun.meeting_run_id);
    if (existing) {
      return existing;
    }
    const recovered: WorkerHandle = {
      meeting_run_id: meetingRun.meeting_run_id,
      worker_id: workerId,
      browser_token: "",
      stop_requested: meetingRun.state === "stopping",
      completed: meetingRun.state === "completed" || meetingRun.state === "failed" || meetingRun.state === "aborted",
      child: null,
      child_pid: meetingRun.worker?.pid ?? null,
    };
    this.workersByMeetingRunId.set(meetingRun.meeting_run_id, recovered);
    this.workersByWorkerId.set(workerId, recovered);
    return recovered;
  }

  private ensureWorkerOwnership(meetingRunId: string, workerId: string): Response | null {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const expectedWorkerId =
      this.workersByMeetingRunId.get(meetingRunId)?.worker_id ??
      this.workersByWorkerId.get(workerId)?.worker_id ??
      meetingRun.worker?.worker_id ??
      null;
    if (!expectedWorkerId) {
      return errorResponse(409, "worker_not_registered", "Worker is not registered for this meeting run");
    }
    if (expectedWorkerId !== workerId) {
      return errorResponse(409, "worker_mismatch", "Worker does not own this meeting run");
    }
    this.recoverWorkerHandle(meetingRun, workerId);
    return null;
  }

  private patchMeetingRunFromEvents(meetingRunId: string, events: EventEnvelope[]): void {
    if (events.length === 0) {
      return;
    }
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun || ["completed", "failed", "aborted"].includes(meetingRun.state)) {
      return;
    }

    const latestTs = events[events.length - 1]?.ts_unix_ms ?? nowUnixMs();
    const patch: {
      state?: MeetingRunRecord["state"];
      started_at_unix_ms?: number | null;
      updated_at_unix_ms: number;
      last_error_code?: string | null;
      last_error_message?: string | null;
    } = {
      updated_at_unix_ms: latestTs,
    };

    for (const event of events) {
      if (event.kind === "audio.capture.started") {
        patch.state = "capturing";
        if (!meetingRun.started_at && patch.started_at_unix_ms === undefined) {
          patch.started_at_unix_ms = event.ts_unix_ms;
        }
      } else if (event.kind === "audio.capture.stopped") {
        patch.state = "stopping";
      } else if (event.kind === "system.worker.started") {
        patch.state = "starting";
      } else if (event.kind === "error.raised") {
        const payload = event.payload as { code?: string; message?: string };
        patch.last_error_code = payload.code ?? "worker_error";
        patch.last_error_message = payload.message ?? "";
      }
    }

    this.storage.patchMeetingRun(meetingRunId, patch);
  }

  private requireInternalAuth(request: Request): Response | null {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${this.config.coordinator_token}`) {
      return errorResponse(401, "unauthorized", "Missing or invalid internal auth token");
    }
    return null;
  }

  private handleHealth(request: Request): Response {
    const response: HealthResponse = {
      ok: true,
      now: new Date().toISOString(),
      mode: this.config.mode === "worker" ? "api" : this.config.mode,
      sqlite: {
        path: this.config.sqlite_path,
        wal_mode: this.storage.getJournalMode().toLowerCase() === "wal",
        writable: true,
      },
      workers: {
        active_count: this.storage.countActiveWorkers(),
      },
    };
    return jsonResponse(response);
  }

  private async initializeMeetingRun(input: {
    normalized: ReturnType<typeof normalizeZoomJoinUrl>;
    requested_by: string | null;
    bot_name: string;
    tags: string[];
    options: MeetingRunOptions;
  }): Promise<{ meeting_run_id: string; layout: MeetingRunFileLayout; meeting_run: MeetingRunRecord | null }> {
    const now = nowUnixMs();
    const actualMeetingRunId = uuidv7(now);
    const layout = await createMeetingRunLayout(this.config.data_root, actualMeetingRunId, now, input.options.persist_live_pcm);
    const metadata = {
      meeting_run_id: actualMeetingRunId,
      room_id: input.normalized.room_id,
      normalized_join_url: input.normalized.normalized_join_url,
      requested_by: input.requested_by,
      bot_name: input.bot_name,
      created_at_unix_ms: now,
      tags: input.tags,
      options: input.options,
    };
    await writeMeetingMetadata(layout, metadata);
    await writeMeetingLifecycle(layout, buildLifecycleFile(actualMeetingRunId, "pending", now));

    this.storage.upsertRoom({
      room_id: input.normalized.room_id,
      provider_room_key: input.normalized.provider_room_key,
      normalized_join_url: input.normalized.normalized_join_url,
      display_name: null,
      now_unix_ms: now,
    });
    this.storage.insertMeetingRun({
      meeting_run_id: actualMeetingRunId,
      room_id: input.normalized.room_id,
      normalized_join_url: input.normalized.normalized_join_url,
      requested_by: input.requested_by,
      bot_name: input.bot_name,
      state: "pending",
      created_at_unix_ms: now,
      data_dir: layout.data_dir,
      tags: input.tags,
      options: input.options,
      paths: layout,
    });

    const createdEvent = this.buildCoordinatorEvent(actualMeetingRunId, input.normalized.room_id, "system.meeting_run.created", {
      join_url: input.normalized.normalized_join_url,
      requested_by: input.requested_by,
      tags: input.tags,
    }, now);
    const appended = this.storage.appendEvents([createdEvent], now);
    this.eventBus.publish(appended.records);

    return {
      meeting_run_id: actualMeetingRunId,
      layout,
      meeting_run: this.storage.getMeetingRunRecord(actualMeetingRunId),
    };
  }

  private async handleCreateMeetingRun(request: Request): Promise<Response> {
    const body = await parseJsonBody<CreateMeetingRunRequest>(request);
    if (!body.join_url) {
      return errorResponse(400, "invalid_request", "`join_url` is required");
    }

    const normalized = normalizeZoomJoinUrl(body.join_url);
    const options = buildMeetingRunOptions(this.config, body.options);
    const botName = body.bot_name?.trim() || this.config.default_bot_name;
    const initialized = await this.initializeMeetingRun({
      normalized,
      requested_by: body.requested_by ?? null,
      bot_name: botName,
      tags: body.tags ?? [],
      options,
    });
    const actualMeetingRunId = initialized.meeting_run_id;
    const layout = initialized.layout;

    const workerLaunchConfig: WorkerLaunchConfig = {
      app: this.config,
      meeting_run_id: actualMeetingRunId,
      room_id: normalized.room_id,
      normalized_join_url: normalized.normalized_join_url,
      bot_name: botName,
      requested_by: body.requested_by ?? null,
      tags: body.tags ?? [],
      options,
      paths: layout,
      browser_token: randomToken(24),
    };

    try {
      await this.spawnWorker(workerLaunchConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.storage.patchMeetingRun(actualMeetingRunId, {
        state: "failed",
        updated_at_unix_ms: nowUnixMs(),
        last_error_code: "worker_spawn_failed",
        last_error_message: message,
      });
      return errorResponse(500, "worker_spawn_failed", "Failed to start worker", { message });
    }

    return jsonResponse({ meeting_run: this.storage.getMeetingRunRecord(actualMeetingRunId) }, { status: 201 });
  }

  private async handleStartSimulation(request: Request): Promise<Response> {
    const body = await parseJsonBody<StartSimulationRequest>(request);
    if (!body.script?.trim()) {
      return errorResponse(400, "invalid_request", "`script` is required");
    }

    let scenario: SimulationScenario;
    try {
      scenario = parseSimulationScript(body.script);
    } catch (error) {
      return errorResponse(400, "invalid_simulation_script", error instanceof Error ? error.message : String(error));
    }

    const meetingId = body.meeting_id?.trim() || scenario.meeting_id;
    if (!meetingId) {
      return errorResponse(400, "invalid_request", "`meeting_id` is required");
    }
    const speed = body.speed && body.speed > 0 ? body.speed : scenario.speed;
    const title = body.title?.trim() || scenario.title || `Simulated Zoom ${meetingId}`;
    const botName = body.bot_name?.trim() || scenario.bot_name || "Meter Simulator";
    const requestedBy = body.requested_by?.trim() || scenario.requested_by || "simulation";
    const tags = Array.from(new Set(["simulation", ...(scenario.tags ?? []), ...((body.tags ?? []).map((item) => item.trim()).filter(Boolean))]));
    const normalized = {
      room_id: `zoom:${meetingId}`,
      provider_room_key: meetingId,
      normalized_join_url: `https://app.zoom.us/wc/join/${meetingId}`,
    };
    const options = buildMeetingRunOptions(this.config, {
      enable_transcription: true,
      enable_speaker_tracking: true,
      enable_chat_tracking: true,
      persist_archive_audio: false,
      persist_live_pcm: false,
    });

    const initialized = await this.initializeMeetingRun({
      normalized,
      requested_by: requestedBy,
      bot_name: botName,
      tags,
      options,
    });
    const meetingRun = initialized.meeting_run;
    if (!meetingRun) {
      return errorResponse(500, "internal_error", "Failed to initialize simulation run");
    }

    this.startSimulation(meetingRun, {
      ...scenario,
      meeting_id: meetingId,
      title,
      bot_name: botName,
      requested_by: requestedBy,
      speed,
      tags,
    });

    const baseUrl = this.resolvePublicBaseUrl(request);
    const response: StartSimulationResponse = {
      meeting_run: meetingRun,
      simulation: {
        meeting_id: meetingId,
        room_id: normalized.room_id,
        transcript_url: `${baseUrl}/v1/zoom-meetings/${encodeURIComponent(meetingId)}/transcript.md?meeting_run_id=${meetingRun.meeting_run_id}`,
        attendees_url: `${baseUrl}/v1/zoom-meetings/${encodeURIComponent(meetingId)}/attendees?meeting_run_id=${meetingRun.meeting_run_id}`,
        attendees_markdown_url: `${baseUrl}/v1/zoom-meetings/${encodeURIComponent(meetingId)}/attendees.md?meeting_run_id=${meetingRun.meeting_run_id}`,
        stream_url: `${baseUrl}/v1/zoom-meetings/${encodeURIComponent(meetingId)}/stream?meeting_run_id=${meetingRun.meeting_run_id}`,
      },
    };
    return jsonResponse(response, { status: 201 });
  }

  private async spawnWorker(launchConfig: WorkerLaunchConfig): Promise<void> {
    const entryScript = path.resolve(new URL("../server.ts", import.meta.url).pathname);
    const child = Bun.spawn([process.execPath, entryScript, "--mode", "worker"], {
      cwd: path.dirname(entryScript),
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        METER_WORKER_CONFIG_B64: encodeBase64Json(launchConfig),
      },
    });
    const handle: WorkerHandle = {
      meeting_run_id: launchConfig.meeting_run_id,
      worker_id: null,
      browser_token: launchConfig.browser_token,
      stop_requested: false,
      completed: false,
      child,
      child_pid: child.pid ?? null,
    };
    this.workersByMeetingRunId.set(launchConfig.meeting_run_id, handle);
    await this.persistWorkersState();

    child.exited.then(async (code) => {
      const current = this.workersByMeetingRunId.get(launchConfig.meeting_run_id);
      if (!current || current.completed) {
        return;
      }
      current.child = null;
      current.child_pid = null;
      const run = this.storage.getMeetingRunRecord(launchConfig.meeting_run_id);
      if (!run || ["completed", "failed", "aborted"].includes(run.state)) {
        return;
      }
      const ts = nowUnixMs();
      const event = this.buildCoordinatorEvent(
        launchConfig.meeting_run_id,
        launchConfig.room_id,
        "system.worker.failed",
        {
          code: "worker_exit",
          message: `Worker exited with code ${code}`,
          fatal: true,
        },
        ts,
      );
      const appended = this.storage.appendEvents([event], ts);
      this.storage.patchMeetingRun(launchConfig.meeting_run_id, {
        state: "failed",
        ended_at_unix_ms: ts,
        updated_at_unix_ms: ts,
        last_error_code: "worker_exit",
        last_error_message: `Worker exited with code ${code}`,
      });
      await this.stopAutomatedRescueForMeetingRun(launchConfig.meeting_run_id, "worker exited");
      this.rescueClaimsByMeetingRunId.delete(launchConfig.meeting_run_id);
      this.eventBus.publish(appended.records);
      await this.persistWorkersState();
    });
  }

  private async persistWorkersState(): Promise<void> {
    const items = Array.from(this.workersByMeetingRunId.values()).map((handle) => ({
      meeting_run_id: handle.meeting_run_id,
      worker_id: handle.worker_id,
      stop_requested: handle.stop_requested,
      completed: handle.completed,
      pid: handle.child?.pid ?? handle.child_pid ?? null,
    }));
    const coordinatorStatePath = path.join(this.config.data_root, "coordinator", "state", "workers.json");
    await Bun.write(coordinatorStatePath, `${JSON.stringify(items, null, 2)}\n`, { createPath: true });
  }

  private buildCoordinatorEvent(
    meetingRunId: string,
    roomId: string,
    kind: EventEnvelope["kind"],
    payload: unknown,
    tsUnixMs: number,
  ): EventEnvelope {
    return {
      meeting_run_id: meetingRunId,
      room_id: roomId,
      seq: this.storage.reserveCoordinatorSeq(meetingRunId),
      source: "system",
      kind,
      ts_unix_ms: tsUnixMs,
      payload,
    };
  }

  private async appendCoordinatorEventAndPublish(
    meetingRunId: string,
    roomId: string,
    kind: EventEnvelope["kind"],
    payload: unknown,
    tsUnixMs: number,
  ): Promise<void> {
    const appended = this.storage.appendEvents([
      this.buildCoordinatorEvent(meetingRunId, roomId, kind, payload, tsUnixMs),
    ], tsUnixMs);
    this.eventBus.publish(appended.records);
  }

  private listResponse<T>(items: T[]): ListResponse<T> {
    return {
      items,
      next_cursor: null,
    };
  }

  private handleListMeetingRuns(url: URL, roomIdOverride?: string): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 100), 500);
    const items = this.storage.listMeetingRunRecords({
      state: url.searchParams.get("state"),
      room_id: roomIdOverride ?? url.searchParams.get("room_id"),
      from: parseTimestamp(url.searchParams.get("from")),
      to: parseTimestamp(url.searchParams.get("to")),
      limit,
    });
    return jsonResponse(this.listResponse(items));
  }

  private handleGetMeetingRun(meetingRunId: string): Response {
    const record = this.getMeetingRun(meetingRunId);
    if (!record) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    return jsonResponse({ meeting_run: record });
  }

  private handleGetZoomMeeting(meetingId: string, url: URL): Response {
    const roomId = this.zoomRoomIdFromMeetingId(meetingId);
    const meetingRun = this.resolveMeetingRunForRoom(roomId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return jsonResponse({
      meeting_id: decodeURIComponent(meetingId),
      room_id: roomId,
      meeting_run,
    });
  }

  private handleGetMinutes(meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const minuteJob = this.getLatestMinuteJob(meetingRunId);
    const latestVersion = minuteJob ? this.storage.getLatestMinuteVersionForMinuteJob(minuteJob.minute_job_id) : null;
    return jsonResponse({
      meeting_run_id: meetingRunId,
      minute_job: minuteJob,
      latest_version: latestVersion,
    });
  }

  private handleZoomMeetingMinutes(url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return this.handleGetMinutes(meetingRun.meeting_run_id);
  }

  private handleMinutesView(request: Request, meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const redirectUrl = new URL("/minutes-view", this.resolvePublicBaseUrl(request));
    redirectUrl.searchParams.set("stream", `/v1/meeting-runs/${meetingRunId}/minutes/stream`);
    redirectUrl.searchParams.set("markdown", `/v1/meeting-runs/${meetingRunId}/minutes.md`);
    redirectUrl.searchParams.set("title", formatRoomLabel(meetingRun.room_id));
    return Response.redirect(redirectUrl.toString(), 302);
  }

  private handleZoomMeetingMinutesView(request: Request, url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    const redirectUrl = new URL("/minutes-view", this.resolvePublicBaseUrl(request));
    redirectUrl.searchParams.set("stream", `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/minutes/stream${url.searchParams.get("meeting_run_id") ? `?meeting_run_id=${encodeURIComponent(url.searchParams.get("meeting_run_id") as string)}` : ""}`);
    redirectUrl.searchParams.set("markdown", `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/minutes.md${url.searchParams.get("meeting_run_id") ? `?meeting_run_id=${encodeURIComponent(url.searchParams.get("meeting_run_id") as string)}` : ""}`);
    redirectUrl.searchParams.set("title", formatRoomLabel(meetingRun.room_id));
    return Response.redirect(redirectUrl.toString(), 302);
  }

  private async handleStartMinutes(request: Request, meetingRunId: string): Promise<Response> {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const existing = this.minuteJobsByMeetingRunId.get(meetingRunId);
    if (existing && !existing.completed) {
      return errorResponse(409, "minutes_already_running", "Minutes are already running for this meeting run");
    }
    const body = await parseJsonBody<StartMinuteJobRequest>(request).catch(() => ({} as StartMinuteJobRequest));
    const minuteJob = await this.spawnMinuteJob(meetingRun, this.buildMinutePromptConfig(body), null);
    return jsonResponse({ minute_job: minuteJob }, { status: 201 });
  }

  private async handleRestartMinutes(request: Request, meetingRunId: string): Promise<Response> {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const body = await parseJsonBody<RestartMinuteJobRequest>(request).catch(() => ({} as RestartMinuteJobRequest));
    const current = this.minuteJobsByMeetingRunId.get(meetingRunId);
    let restartedFrom: string | null = null;
    if (current && !current.completed) {
      restartedFrom = current.minute_job_id;
      this.storage.patchMinuteJob(current.minute_job_id, { state: "restarting" });
      current.stop_requested = true;
      await this.terminateMinuteJob(current);
    }
    const minuteJob = await this.spawnMinuteJob(meetingRun, this.buildMinutePromptConfig(body), restartedFrom);
    return jsonResponse({ minute_job: minuteJob }, { status: restartedFrom ? 200 : 201 });
  }

  private async handleStopMinutes(request: Request, meetingRunId: string): Promise<Response> {
    if (!this.getMeetingRun(meetingRunId)) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const body = await parseJsonBody<StopMinuteJobRequest>(request).catch(() => ({} as StopMinuteJobRequest));
    const current = this.minuteJobsByMeetingRunId.get(meetingRunId);
    if (!current || current.completed) {
      return errorResponse(409, "minutes_not_running", "Minutes are not running for this meeting run");
    }
    current.stop_requested = true;
    this.storage.patchMinuteJob(current.minute_job_id, {
      state: "stopping",
    });
    await this.terminateMinuteJob(current);
    return jsonResponse({ ok: true });
  }

  private handleMinutesMarkdown(meetingRunId: string, _request: Request): Response {
    const minuteJob = this.getLatestMinuteJob(meetingRunId);
    if (!minuteJob || !existsSync(minuteJob.latest_minutes_path)) {
      return errorResponse(404, "not_found", "Minutes not found");
    }
    const markdown = readFileSync(minuteJob.latest_minutes_path, "utf-8");
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private handleZoomMeetingMinutesMarkdown(url: URL, meetingId: string, request: Request): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return this.handleMinutesMarkdown(meetingRun.meeting_run_id, request);
  }

  private handleListMinuteVersions(meetingRunId: string, url: URL): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 50), 200);
    return jsonResponse(this.listResponse(this.storage.listMinuteVersionRecordsForMeetingRun(meetingRunId, limit)));
  }

  private handleGetRescueStatus(request: Request, meetingRunId: string): Response {
    const record = this.getMeetingRun(meetingRunId);
    if (!record) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    return jsonResponse({
      rescue: this.buildRescueStatus(record, this.resolvePublicBaseUrl(request)),
    });
  }

  private async handleRescueClaim(request: Request, meetingRunId: string): Promise<Response> {
    const record = this.getMeetingRun(meetingRunId);
    if (!record) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    if (["completed", "failed", "aborted"].includes(record.state)) {
      return errorResponse(409, "meeting_run_terminal", "Meeting run is already in a terminal state");
    }
    if (record.worker?.status !== "online" || !record.worker?.cdp_port) {
      return errorResponse(409, "worker_unavailable", "No live worker/browser is available to rescue this meeting run");
    }
    const body = await parseJsonBody<RescueClaimRequest>(request).catch(() => ({} as RescueClaimRequest));
    const existing = this.rescueClaimsByMeetingRunId.get(meetingRunId);
    const requestedOperator = body.operator?.trim() || "codex";
    if (existing?.claimed && existing.operator && existing.operator !== requestedOperator) {
      return errorResponse(409, "rescue_already_claimed", "Meeting run is already claimed for operator assistance", {
        operator: existing.operator,
      });
    }
    const now = nowUnixMs();
    const claim: RescueClaimState = {
      claimed: true,
      operator: requestedOperator,
      reason: body.reason?.trim() || null,
      note: body.note?.trim() || null,
      claimed_at_unix_ms: now,
      released_at_unix_ms: null,
    };
    this.rescueClaimsByMeetingRunId.set(meetingRunId, claim);
    if (requestedOperator !== this.automatedRescueConfig.operator_name) {
      void this.stopAutomatedRescueForMeetingRun(meetingRunId, `operator claim transferred to ${requestedOperator}`);
    }
    await this.appendCoordinatorEventAndPublish(
      meetingRunId,
      record.room_id,
      "system.operator_assistance.claimed",
      {
        operator: claim.operator,
        reason: claim.reason,
        note: claim.note,
      } satisfies OperatorAssistancePayload,
      now,
    );
    return jsonResponse({
      rescue: this.buildRescueStatus(this.getMeetingRun(meetingRunId) ?? record, this.resolvePublicBaseUrl(request)),
    });
  }

  private async handleRescueRelease(request: Request, meetingRunId: string): Promise<Response> {
    const record = this.getMeetingRun(meetingRunId);
    if (!record) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const current = this.rescueClaimsByMeetingRunId.get(meetingRunId);
    const body = await parseJsonBody<RescueReleaseRequest>(request).catch(() => ({} as RescueReleaseRequest));
    const now = nowUnixMs();
    const released: RescueClaimState = {
      claimed: false,
      operator: body.operator?.trim() || current?.operator || "codex",
      reason: current?.reason ?? null,
      note: body.note?.trim() || current?.note || null,
      claimed_at_unix_ms: current?.claimed_at_unix_ms ?? null,
      released_at_unix_ms: now,
    };
    this.rescueClaimsByMeetingRunId.set(meetingRunId, released);
    await this.appendCoordinatorEventAndPublish(
      meetingRunId,
      record.room_id,
      "system.operator_assistance.released",
      {
        operator: released.operator,
        reason: released.reason,
        note: released.note,
      } satisfies OperatorAssistancePayload,
      now,
    );
    return jsonResponse({
      rescue: this.buildRescueStatus(this.getMeetingRun(meetingRunId) ?? record, this.resolvePublicBaseUrl(request)),
    });
  }

  private handleStopMeetingRun(meetingRunId: string): Response {
    const record = this.getMeetingRun(meetingRunId);
    if (!record) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    if (["completed", "failed", "aborted"].includes(record.state)) {
      return errorResponse(409, "meeting_run_terminal", "Meeting run is already in a terminal state");
    }
    const simulation = this.simulationsByMeetingRunId.get(meetingRunId) ?? null;
    const handle =
      this.workersByMeetingRunId.get(meetingRunId) ??
      (record.worker?.worker_id ? this.recoverWorkerHandle(record, record.worker.worker_id) : null);
    if (!simulation && (!handle || !record.worker?.worker_id)) {
      return errorResponse(409, "worker_unavailable", "No worker is available to stop this meeting run");
    }
    if (simulation?.cancelled || handle?.stop_requested) {
      return jsonResponse({
        meeting_run_id: meetingRunId,
        accepted: true,
      });
    }
    if (handle) {
      handle.stop_requested = true;
    }
    this.rescueClaimsByMeetingRunId.delete(meetingRunId);
    void this.stopAutomatedRescueForMeetingRun(meetingRunId, "stop requested");
    void this.stopSimulationForMeetingRun(meetingRunId, "stop requested");
    void this.persistWorkersState();
    this.storage.patchMeetingRun(meetingRunId, {
      state: "stopping",
      updated_at_unix_ms: nowUnixMs(),
    });
    return jsonResponse({
      meeting_run_id: meetingRunId,
      accepted: true,
    });
  }

  private handleListEvents(url: URL, meetingRunIdOverride?: string): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 250), 1000);
    const items = this.storage.listEventRecords({
      meeting_run_id: meetingRunIdOverride ?? url.searchParams.get("meeting_run_id"),
      room_id: url.searchParams.get("room_id"),
      source: url.searchParams.get("source"),
      kind: url.searchParams.get("kind"),
      from: parseTimestamp(url.searchParams.get("from")),
      to: parseTimestamp(url.searchParams.get("to")),
      after_event_id: parseTimestamp(url.searchParams.get("after_event_id")),
      limit,
    });
    return jsonResponse(this.listResponse(items));
  }

  private handleListSpeech(url: URL, meetingRunIdOverride?: string): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 250), 1000);
    const items = this.storage.listSpeechRecords({
      meeting_run_id: meetingRunIdOverride ?? url.searchParams.get("meeting_run_id"),
      room_id: url.searchParams.get("room_id"),
      speaker_label: url.searchParams.get("speaker_label"),
      status: url.searchParams.get("status"),
      q: url.searchParams.get("q"),
      from: parseTimestamp(url.searchParams.get("from")),
      to: parseTimestamp(url.searchParams.get("to")),
      limit,
    });
    return jsonResponse(this.listResponse(items));
  }

  private buildRescueStatus(meetingRun: MeetingRunRecord, publicBaseUrl: string): RescueStatusResponse {
    const claim = this.rescueClaimsByMeetingRunId.get(meetingRun.meeting_run_id);
    const events = this.storage.listEventRecords({
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: null,
      source: null,
      kind: null,
      from: null,
      to: null,
      after_event_id: null,
      limit: 10_000,
    });
    const latestByKind = new Map<string, EventRecord>();
    for (const event of events) {
      latestByKind.set(event.kind, event);
    }

    const pageLoaded = latestByKind.get("browser.page.loaded") ?? null;
    const meetingJoined = latestByKind.get("zoom.meeting.joined") ?? null;
    const captureStarted = latestByKind.get("audio.capture.started") ?? null;
    const captureStopped = latestByKind.get("audio.capture.stopped") ?? null;
    const bootstrapReady = latestByKind.get("browser.capture.bootstrap_ready") ?? null;
    const latestBrowserConsole = [...events].reverse().find((event) => event.kind === "browser.console") ?? null;
    const recentErrors = [...events]
      .reverse()
      .filter((event) => event.kind === "error.raised")
      .slice(0, 5)
      .map((event) => {
        const payload = event.payload as { code?: string; message?: string; details?: Record<string, unknown> };
        return {
          code: payload.code ?? "worker_error",
          message: payload.message ?? "",
          details: payload.details,
        };
      });

    const now = nowUnixMs();
    const createdAtUnixMs = Date.parse(meetingRun.created_at) || now;
    const latestProgressUnixMs = Math.max(
      createdAtUnixMs,
      Date.parse((latestByKind.get("system.worker.started")?.ts) ?? "") || 0,
      Date.parse((bootstrapReady?.ts) ?? "") || 0,
      Date.parse((pageLoaded?.ts) ?? "") || 0,
      Date.parse((meetingJoined?.ts) ?? "") || 0,
      Date.parse((captureStarted?.ts) ?? "") || 0,
    );
    const latestStopProgressUnixMs = Math.max(
      latestProgressUnixMs,
      Date.parse((captureStopped?.ts) ?? "") || 0,
    );
    let suggestedReason: string | null = null;
    if (meetingRun.worker?.status === "online" && !captureStarted) {
      if (meetingRun.state === "starting" && now - latestProgressUnixMs > 20_000 && !pageLoaded) {
        suggestedReason = "browser_has_not_loaded";
      } else if (meetingRun.state === "joining" && now - latestProgressUnixMs > 30_000) {
        suggestedReason = "join_flow_stalled";
      } else if (meetingRun.state === "stopping" && now - latestStopProgressUnixMs > 20_000) {
        suggestedReason = "stop_flow_stalled";
      }
    }

    return {
      meeting_run_id: meetingRun.meeting_run_id,
      claimed: claim?.claimed ?? false,
      operator: claim?.operator ?? null,
      reason: claim?.reason ?? null,
      note: claim?.note ?? null,
      claimed_at: claim?.claimed_at_unix_ms ? new Date(claim.claimed_at_unix_ms).toISOString() : null,
      state: meetingRun.state,
      worker_online: meetingRun.worker?.status === "online",
      cdp_port: meetingRun.worker?.cdp_port ?? null,
      ingest_port: meetingRun.worker?.ingest_port ?? null,
      needs_assistance: Boolean((claim?.claimed ?? false) || suggestedReason),
      suggested_reason: suggestedReason,
      checkpoints: {
        page_loaded: Boolean(pageLoaded),
        meeting_joined: Boolean(meetingJoined),
        capture_started: Boolean(captureStarted),
        capture_stopped: Boolean(captureStopped),
      },
      latest_page_url:
        ((meetingJoined?.payload as { page_url?: string | null } | undefined)?.page_url ??
          (pageLoaded?.payload as { page_url?: string | null } | undefined)?.page_url ??
          null),
      latest_browser_console:
        ((latestBrowserConsole?.payload as { text?: string | null } | undefined)?.text ?? null),
      recent_errors: recentErrors,
      screenshot_url:
        meetingRun.worker?.status === "online" && meetingRun.worker?.cdp_port
          ? `${publicBaseUrl}/v1/meeting-runs/${meetingRun.meeting_run_id}/screenshot`
          : null,
      browser_bootstrap_url:
        ((bootstrapReady?.payload as { bootstrap_url?: string | null } | undefined)?.bootstrap_url ?? null),
    };
  }

  private rescueBaseUrl(): string {
    return this.config.public_base_url || `http://${this.config.listen_host}:${this.config.listen_port}`;
  }

  private async loadRescuePromptTemplate(): Promise<string> {
    if (!this.rescuePromptTemplatePromise) {
      const promptPath = path.join(this.automatedRescueConfig.repo_root, "RESCUE_PROMPT.md");
      this.rescuePromptTemplatePromise = Bun.file(promptPath).text().catch(() => [
        "# Meter Rescue Prompt",
        "",
        "See RESCUE_PROMPT.md in the repo root. This fallback prompt was generated because the file could not be read.",
      ].join("\n"));
    }
    return await this.rescuePromptTemplatePromise;
  }

  private async renderAutomatedRescuePrompt(
    meetingRun: MeetingRunRecord,
    rescueStatus: RescueStatusResponse,
    runtimeContext?: Record<string, unknown>,
  ): Promise<string> {
    const template = await this.loadRescuePromptTemplate();
    const rescueArtifacts = (runtimeContext?.rescue_artifacts ?? null) as Record<string, unknown> | null;
    const extraContext = [
      "Automated rescue was triggered by the Meter coordinator.",
      rescueStatus.suggested_reason ? `Suggested reason: ${rescueStatus.suggested_reason}` : null,
      rescueStatus.latest_browser_console ? `Latest browser console: ${rescueStatus.latest_browser_console}` : null,
      rescueStatus.recent_errors.length > 0
        ? `Recent errors: ${rescueStatus.recent_errors.map((item) => `${item.code}: ${item.message}`).join(" | ")}`
        : null,
    ].filter(Boolean).join("\n");
    const replacements: Record<string, string> = {
      "{{METER_BASE_URL}}": this.rescueBaseUrl(),
      "{{MEETING_RUN_ID}}": meetingRun.meeting_run_id,
      "{{ROOM_ID}}": meetingRun.room_id,
      "{{REQUESTED_BY}}": meetingRun.requested_by ?? "",
      "{{BOT_NAME}}": meetingRun.bot_name,
      "{{JOIN_URL}}": meetingRun.normalized_join_url,
      "{{OPERATOR_NAME}}": this.automatedRescueConfig.operator_name,
      "{{TIMEOUT_BUDGET}}": `${this.automatedRescueConfig.timeout_ms}ms`,
      "{{RESCUE_STATUS_JSON}}": JSON.stringify(rescueStatus, null, 2),
      "{{RESCUE_ARTIFACTS_JSON}}": JSON.stringify(rescueArtifacts, null, 2),
      "{{EXTRA_CONTEXT}}": extraContext,
    };
    let rendered = template;
    for (const [needle, value] of Object.entries(replacements)) {
      rendered = rendered.split(needle).join(value);
    }
    return [
      rendered,
      "",
      "## Generated Runtime Context",
      "",
      "```json",
      JSON.stringify({
        generated_at: new Date().toISOString(),
        base_url: this.rescueBaseUrl(),
        operator_name: this.automatedRescueConfig.operator_name,
        rescue_status: rescueStatus,
        meeting_run: meetingRun,
        ...(runtimeContext ?? {}),
      }, null, 2),
      "```",
      "",
    ].join("\n");
  }

  private maybeStartAutomatedRescue(meetingRunId: string): void {
    void this.maybeStartAutomatedRescueInternal(meetingRunId);
  }

  private async maybeStartAutomatedRescueInternal(meetingRunId: string): Promise<void> {
    if (!this.automatedRescueConfig.enabled || !this.automatedRescueConfig.command) {
      return;
    }
    if (this.automatedRescueAttemptsByMeetingRunId.has(meetingRunId)) {
      return;
    }
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun || ["completed", "failed", "aborted"].includes(meetingRun.state)) {
      return;
    }
    if (this.rescueClaimsByMeetingRunId.get(meetingRunId)?.claimed) {
      return;
    }
    const attempts = this.automatedRescueAttemptCountsByMeetingRunId.get(meetingRunId) ?? 0;
    if (attempts >= this.automatedRescueConfig.max_attempts) {
      return;
    }
    const lastAttemptAt = this.automatedRescueLastAttemptByMeetingRunId.get(meetingRunId) ?? 0;
    const now = nowUnixMs();
    if (lastAttemptAt > 0 && now - lastAttemptAt < this.automatedRescueConfig.cooldown_ms) {
      return;
    }

    const rescueStatus = this.buildRescueStatus(meetingRun, this.rescueBaseUrl());
    if (!rescueStatus.needs_assistance || !rescueStatus.suggested_reason || !rescueStatus.worker_online || !rescueStatus.cdp_port) {
      return;
    }

    const attemptNumber = attempts + 1;
    this.automatedRescueAttemptCountsByMeetingRunId.set(meetingRunId, attemptNumber);
    this.automatedRescueLastAttemptByMeetingRunId.set(meetingRunId, now);
    await this.launchAutomatedRescue(meetingRun, rescueStatus, attemptNumber);
  }

  private async launchAutomatedRescue(
    meetingRun: MeetingRunRecord,
    rescueStatus: RescueStatusResponse,
    attemptNumber: number,
  ): Promise<void> {
    const rescueDir = path.join(meetingRun.paths.data_dir, "rescue");
    const promptPath = path.join(rescueDir, `attempt-${attemptNumber}.prompt.md`);
    const contextPath = path.join(rescueDir, `attempt-${attemptNumber}.context.json`);
    const logPath = path.join(rescueDir, `attempt-${attemptNumber}.log`);
    const context = {
      generated_at: new Date().toISOString(),
      command: this.automatedRescueConfig.command,
      operator_name: this.automatedRescueConfig.operator_name,
      base_url: this.rescueBaseUrl(),
      rescue_artifacts: {
        prompt_path: promptPath,
        context_path: contextPath,
        log_path: logPath,
      },
      rescue_status: rescueStatus,
      meeting_run: meetingRun,
    };
    const prompt = await this.renderAutomatedRescuePrompt(meetingRun, rescueStatus, {
      rescue_artifacts: context.rescue_artifacts,
    });
    await Bun.write(promptPath, prompt, { createPath: true });
    await Bun.write(contextPath, `${JSON.stringify(context, null, 2)}\n`, { createPath: true });
    await appendLogLine(logPath, `launching automated rescue attempt=${attemptNumber} reason=${rescueStatus.suggested_reason}`);
    await appendLogLine(this.coordinatorLogPath, `launching automated rescue run=${meetingRun.meeting_run_id} attempt=${attemptNumber} reason=${rescueStatus.suggested_reason}`);

    const attempt: AutomatedRescueAttempt = {
      meeting_run_id: meetingRun.meeting_run_id,
      attempt_number: attemptNumber,
      reason: rescueStatus.suggested_reason,
      started_at_unix_ms: nowUnixMs(),
      child: null,
      timeout: null,
      log_path: logPath,
      prompt_path: promptPath,
      context_path: contextPath,
    };
    this.automatedRescueAttemptsByMeetingRunId.set(meetingRun.meeting_run_id, attempt);

    try {
      const child = spawn("bash", ["-lc", this.automatedRescueConfig.command], {
        cwd: this.automatedRescueConfig.repo_root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      attempt.child = child;
      child.stdin.end(prompt, "utf8");
      child.stdout.on("data", (chunk) => {
        void this.appendAutomatedRescueOutput(logPath, "stdout", Buffer.from(chunk).toString("utf8"));
      });
      child.stderr.on("data", (chunk) => {
        void this.appendAutomatedRescueOutput(logPath, "stderr", Buffer.from(chunk).toString("utf8"));
      });
      child.on("error", (error) => {
        void appendLogLine(logPath, `spawn error: ${error.message}`);
        void appendLogLine(this.coordinatorLogPath, `automated rescue spawn error run=${meetingRun.meeting_run_id}: ${error.message}`);
      });
      attempt.timeout = setTimeout(() => {
        void appendLogLine(logPath, `timeout reached after ${this.automatedRescueConfig.timeout_ms}ms`);
        try {
          child.kill("SIGTERM");
        } catch {
          return;
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore best effort kill
          }
        }, 2_000);
      }, this.automatedRescueConfig.timeout_ms);
      child.on("close", (code, signal) => {
        const current = this.automatedRescueAttemptsByMeetingRunId.get(meetingRun.meeting_run_id);
        if (current === attempt) {
          this.automatedRescueAttemptsByMeetingRunId.delete(meetingRun.meeting_run_id);
        }
        if (attempt.timeout) {
          clearTimeout(attempt.timeout);
        }
        void appendLogLine(logPath, `process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        void appendLogLine(this.coordinatorLogPath, `automated rescue exited run=${meetingRun.meeting_run_id} attempt=${attemptNumber} code=${code ?? "null"} signal=${signal ?? "null"}`);
      });
    } catch (error) {
      this.automatedRescueAttemptsByMeetingRunId.delete(meetingRun.meeting_run_id);
      const message = error instanceof Error ? error.message : String(error);
      await appendLogLine(logPath, `failed to launch automated rescue: ${message}`);
      await appendLogLine(this.coordinatorLogPath, `failed to launch automated rescue run=${meetingRun.meeting_run_id}: ${message}`);
    }
  }

  private async appendAutomatedRescueOutput(logPath: string, streamName: "stdout" | "stderr", text: string): Promise<void> {
    for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      await appendLogLine(logPath, `[${streamName}] ${line}`);
    }
  }

  private async stopAutomatedRescueForMeetingRun(meetingRunId: string, reason: string): Promise<void> {
    const attempt = this.automatedRescueAttemptsByMeetingRunId.get(meetingRunId);
    if (!attempt) {
      return;
    }
    this.automatedRescueAttemptsByMeetingRunId.delete(meetingRunId);
    if (attempt.timeout) {
      clearTimeout(attempt.timeout);
    }
    await appendLogLine(attempt.log_path, `stopping automated rescue: ${reason}`);
    await appendLogLine(this.coordinatorLogPath, `stopping automated rescue run=${meetingRunId}: ${reason}`);
    const child = attempt.child;
    if (!child) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore best effort kill
        }
        resolve();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private startSimulation(meetingRun: MeetingRunRecord, scenario: SimulationScenario): void {
    const handle: SimulationHandle = {
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: meetingRun.room_id,
      cancelled: false,
      completed: false,
      cancel_reason: null,
      abort_controller: new AbortController(),
      promise: null,
    };
    this.simulationsByMeetingRunId.set(meetingRun.meeting_run_id, handle);
    handle.promise = this.runSimulation(handle, meetingRun, scenario)
      .catch(async (error) => {
        if (handle.completed) {
          return;
        }
        const reason = handle.cancel_reason ?? (error instanceof Error ? error.message : String(error));
        if (handle.cancelled) {
          await this.completeSimulation(meetingRun, reason === "stop requested" ? "completed" : "aborted", null);
          return;
        }
        await this.completeSimulation(meetingRun, "failed", {
          code: "simulation_failed",
          message: reason,
          fatal: true,
        });
      })
      .finally(() => {
        handle.completed = true;
        this.simulationsByMeetingRunId.delete(meetingRun.meeting_run_id);
      });
  }

  private async waitForSimulationDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
      return;
    }
    if (signal.aborted) {
      throw new Error(String(signal.reason ?? "simulation_cancelled"));
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new Error(String(signal.reason ?? "simulation_cancelled")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async appendSyntheticEvent(
    meetingRun: MeetingRunRecord,
    source: EventEnvelope["source"],
    kind: EventEnvelope["kind"],
    payload: unknown,
    tsUnixMs: number,
    raw?: unknown,
  ): Promise<void> {
    const event: EventEnvelope = {
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: meetingRun.room_id,
      seq: this.storage.reserveCoordinatorSeq(meetingRun.meeting_run_id),
      source,
      kind,
      ts_unix_ms: tsUnixMs,
      payload,
      raw,
    };
    const appended = this.storage.appendEvents([event], nowUnixMs());
    this.patchMeetingRunFromEvents(meetingRun.meeting_run_id, [event]);
    this.eventBus.publish(appended.records);
  }

  private async setMeetingRunState(meetingRunId: string, state: MeetingRunRecord["state"], tsUnixMs: number): Promise<void> {
    this.storage.patchMeetingRun(meetingRunId, {
      state,
      updated_at_unix_ms: tsUnixMs,
    });
    if (state === "capturing") {
      this.storage.patchMeetingRun(meetingRunId, {
        started_at_unix_ms: tsUnixMs,
      });
    }
  }

  private async completeSimulation(
    meetingRun: MeetingRunRecord,
    finalState: "completed" | "failed" | "aborted",
    error: { code: string; message: string; fatal: boolean } | null,
  ): Promise<void> {
    const current = this.getMeetingRun(meetingRun.meeting_run_id);
    if (!current || ["completed", "failed", "aborted"].includes(current.state)) {
      return;
    }
    const endedAtUnixMs = nowUnixMs();
    const events: EventEnvelope[] = [];
    let nextSeq = this.storage.reserveCoordinatorSeq(meetingRun.meeting_run_id);
    if (error) {
      events.push({
        meeting_run_id: meetingRun.meeting_run_id,
        room_id: meetingRun.room_id,
        seq: nextSeq,
        source: "system",
        kind: "error.raised",
        ts_unix_ms: endedAtUnixMs,
        payload: error,
      });
      nextSeq -= 1;
    }
    events.push({
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: meetingRun.room_id,
      seq: nextSeq,
      source: "system",
      kind: finalState === "failed" ? "system.worker.failed" : "system.worker.completed",
      ts_unix_ms: endedAtUnixMs,
      payload: {
        worker_id: `simulation:${meetingRun.meeting_run_id}`,
        final_state: finalState,
      },
    });
    const appended = this.storage.appendEvents(events, endedAtUnixMs);
    this.storage.patchMeetingRun(meetingRun.meeting_run_id, {
      state: finalState,
      ended_at_unix_ms: endedAtUnixMs,
      updated_at_unix_ms: endedAtUnixMs,
      last_error_code: error?.code ?? null,
      last_error_message: error?.message ?? null,
    });
    this.eventBus.publish(appended.records);
  }

  private async stopSimulationForMeetingRun(meetingRunId: string, reason: string): Promise<void> {
    const handle = this.simulationsByMeetingRunId.get(meetingRunId);
    if (!handle || handle.completed) {
      return;
    }
    handle.cancelled = true;
    handle.cancel_reason = reason;
    handle.abort_controller.abort(reason);
    await handle.promise?.catch(() => undefined);
  }

  private async runSimulation(handle: SimulationHandle, meetingRun: MeetingRunRecord, scenario: SimulationScenario): Promise<void> {
    const speed = scenario.speed > 0 ? scenario.speed : 1;
    const signal = handle.abort_controller.signal;
    let simulatedTs = nowUnixMs();
    let captureStarted = false;
    let captureStopped = false;
    let joined = false;
    let segmentCounter = 1;
    let chatCounter = 1;
    const attendeeState = new Map<string, ZoomAttendeePresencePayload>();
    const chatState = new Map<string, ZoomChatMessagePayload>();

    const emitJoin = async (stepArgs: Record<string, string>) => {
      joined = true;
      await this.setMeetingRunState(meetingRun.meeting_run_id, "joining", simulatedTs);
      const payload: ZoomMeetingJoinedPayload = {
        title: stepArgs.title ?? scenario.title ?? `Simulated Zoom ${scenario.meeting_id}`,
        page_url: stepArgs.page_url ?? meetingRun.normalized_join_url,
        joined_at_unix_ms: simulatedTs,
      };
      await this.appendSyntheticEvent(meetingRun, "browser", "zoom.meeting.joined", payload, simulatedTs);
    };

    const emitCaptureStarted = async () => {
      if (captureStarted) {
        return;
      }
      captureStarted = true;
      const payload: AudioCaptureStartedPayload = {
        archive_stream_id: `simulation-archive-${meetingRun.meeting_run_id}`,
        live_stream_id: `simulation-live-${meetingRun.meeting_run_id}`,
        archive_content_type: "audio/mpeg",
        archive_codec: "simulation",
        pcm_sample_rate_hz: 16000,
        pcm_channels: 1,
      };
      await this.appendSyntheticEvent(meetingRun, "audio_capture", "audio.capture.started", payload, simulatedTs);
      const transcriptionPayload: TranscriptionSessionStartedPayload = {
        provider: "custom",
        provider_session_id: `simulation:${meetingRun.meeting_run_id}`,
        sample_rate_hz: 16000,
      };
      await this.appendSyntheticEvent(meetingRun, "transcription", "transcription.session.started", transcriptionPayload, simulatedTs);
    };

    const emitCaptureStopped = async (reason: AudioCaptureStoppedPayload["reason"]) => {
      if (!captureStarted || captureStopped) {
        return;
      }
      captureStopped = true;
      const payload: AudioCaptureStoppedPayload = { reason };
      await this.appendSyntheticEvent(meetingRun, "audio_capture", "audio.capture.stopped", payload, simulatedTs);
      await this.appendSyntheticEvent(meetingRun, "transcription", "transcription.session.stopped", {
        provider: "custom",
        provider_session_id: `simulation:${meetingRun.meeting_run_id}`,
      }, simulatedTs);
    };

    const hasJoinStep = scenario.steps.some((step) => step.action === "join");
    const hasCaptureStartStep = scenario.steps.some((step) => step.action === "capture.start");

    await this.appendSyntheticEvent(meetingRun, "system", "system.worker.started", {
      worker_id: `simulation:${meetingRun.meeting_run_id}`,
      pid: process.pid,
      ingest_port: 0,
      cdp_port: 0,
      chrome_user_data_dir: "simulation",
    }, simulatedTs);
    await this.appendSyntheticEvent(meetingRun, "browser", "browser.page.loaded", {
      page_url: meetingRun.normalized_join_url,
      user_agent: "meter-simulation",
    }, simulatedTs);

    if (!hasJoinStep) {
      simulatedTs += 50;
      await emitJoin({});
    }
    if (!hasCaptureStartStep && !hasJoinStep) {
      simulatedTs += 50;
      await emitCaptureStarted();
    }

    let explicitFinalState: "completed" | "failed" | "aborted" | null = null;
    let explicitError: { code: string; message: string; fatal: boolean } | null = null;

    for (const step of scenario.steps) {
      await this.waitForSimulationDelay(Math.round(step.delay_ms / speed), signal);
      simulatedTs += step.delay_ms;

      if (step.action === "join") {
        await emitJoin(step.args);
        if (!hasCaptureStartStep && !captureStarted) {
          simulatedTs += 50;
          await emitCaptureStarted();
        }
        continue;
      }
      if (step.action === "capture.start") {
        await emitCaptureStarted();
        continue;
      }
      if (step.action === "capture.stop") {
        await emitCaptureStopped((step.args.reason as AudioCaptureStoppedPayload["reason"] | undefined) ?? "manual");
        continue;
      }
      if (step.action === "attendee.join") {
        const payload: ZoomAttendeePresencePayload = {
          attendee_id: step.args.id ?? `attendee-${attendeeState.size + 1}`,
          user_id: step.args.user_id ? Number.parseInt(step.args.user_id, 10) : null,
          display_name: step.args.name ?? null,
          is_host: step.args.host === "1" || step.args.host === "true",
          is_co_host: step.args.co_host === "1" || step.args.co_host === "true",
          is_guest: step.args.guest === "1" || step.args.guest === "true",
          muted: step.args.muted === undefined ? null : (step.args.muted === "1" || step.args.muted === "true"),
          video_on: step.args.video_on === undefined ? null : (step.args.video_on === "1" || step.args.video_on === "true"),
          audio_connection: step.args.audio_connection ?? "computer",
          last_spoken_at_unix_ms: null,
          backfilled: false,
          details: {
            simulated: true,
          },
        };
        attendeeState.set(payload.attendee_id, payload);
        await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.attendee.joined", payload, simulatedTs);
        continue;
      }
      if (step.action === "attendee.leave") {
        const attendeeId = step.args.id ?? "";
        const existing = attendeeState.get(attendeeId);
        const payload: ZoomAttendeePresencePayload = {
          attendee_id: attendeeId || existing?.attendee_id || `attendee-${attendeeState.size + 1}`,
          user_id: step.args.user_id ? Number.parseInt(step.args.user_id, 10) : existing?.user_id ?? null,
          display_name: step.args.name ?? existing?.display_name ?? null,
          is_host: existing?.is_host ?? false,
          is_co_host: existing?.is_co_host ?? false,
          is_guest: existing?.is_guest ?? false,
          muted: existing?.muted ?? null,
          video_on: existing?.video_on ?? null,
          audio_connection: existing?.audio_connection ?? "computer",
          last_spoken_at_unix_ms: existing?.last_spoken_at_unix_ms ?? null,
          backfilled: false,
          details: {
            simulated: true,
          },
        };
        attendeeState.delete(payload.attendee_id);
        await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.attendee.left", payload, simulatedTs);
        continue;
      }
      if (step.action === "speaker") {
        const payload: ZoomSpeakerActivePayload = {
          speaker_display_name: step.args.name ?? null,
        };
        await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.speaker.active", payload, simulatedTs);
        continue;
      }
      if (step.action === "say") {
        const speakerLabel = step.args.speaker ?? null;
        if (speakerLabel) {
          await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.speaker.active", {
            speaker_display_name: speakerLabel,
          } satisfies ZoomSpeakerActivePayload, simulatedTs);
        }
        const durationMs = step.args.duration_ms ? Number.parseInt(step.args.duration_ms, 10) : 1500;
        const payload: TranscriptionSegmentPayload = {
          speech_segment_id: step.args.segment ?? `sim-seg-${segmentCounter++}`,
          provider: "custom",
          provider_segment_id: step.args.provider_segment_id ?? null,
          text: step.args.text ?? "",
          status: step.args.status === "partial" ? "partial" : "final",
          started_at_unix_ms: simulatedTs,
          ended_at_unix_ms: simulatedTs + durationMs,
          speaker_label: speakerLabel,
          speaker_confidence: null,
        };
        await this.appendSyntheticEvent(meetingRun, "transcription", payload.status === "partial" ? "transcription.segment.partial" : "transcription.segment.final", payload, simulatedTs);
        continue;
      }
      if (step.action === "chat") {
        const chatMessageId = step.args.id ?? `sim-chat-${chatCounter++}`;
        const replyTo = step.args.reply_to ?? null;
        const payload: ZoomChatMessagePayload = {
          chat_message_id: chatMessageId,
          sender_display_name: step.args.from ?? null,
          sender_user_id: step.args.sender_user_id ? Number.parseInt(step.args.sender_user_id, 10) : null,
          receiver_display_name: step.args.to ?? "Everyone",
          receiver_user_id: step.args.receiver_user_id ? Number.parseInt(step.args.receiver_user_id, 10) : null,
          visibility: step.args.visibility === "direct" ? "direct" : "everyone",
          text: step.args.text ?? "",
          sent_at_unix_ms: simulatedTs,
          main_chat_message_id: replyTo,
          thread_reply_count: replyTo ? 0 : (step.args.replies ? Number.parseInt(step.args.replies, 10) : 0),
          is_thread_reply: Boolean(replyTo),
          is_edited: false,
          chat_type: replyTo ? "thread" : "groupchat",
          details: {
            simulated: true,
          },
        };
        chatState.set(chatMessageId, payload);
        await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.chat.message", payload, simulatedTs);
        if (replyTo) {
          const root = chatState.get(replyTo);
          if (root) {
            const updatedRoot: ZoomChatMessagePayload = {
              ...root,
              thread_reply_count: (root.thread_reply_count ?? 0) + 1,
            };
            chatState.set(replyTo, updatedRoot);
            await this.appendSyntheticEvent(meetingRun, "zoom_dom", "zoom.chat.message", updatedRoot, simulatedTs);
          }
        }
        continue;
      }
      if (step.action === "console") {
        const payload: BrowserConsolePayload = {
          level: (step.args.level as BrowserConsolePayload["level"] | undefined) ?? "info",
          text: step.args.text ?? "",
        };
        await this.appendSyntheticEvent(meetingRun, "browser", "browser.console", payload, simulatedTs);
        continue;
      }
      if (step.action === "event") {
        if (!step.args.kind || !step.args.source || !step.args.payload) {
          throw new Error(`Simulation event step on line ${step.line} requires source=, kind=, and payload=`);
        }
        const payload = JSON.parse(step.args.payload);
        const raw = step.args.raw ? JSON.parse(step.args.raw) : undefined;
        await this.appendSyntheticEvent(
          meetingRun,
          step.args.source as EventEnvelope["source"],
          step.args.kind as EventEnvelope["kind"],
          payload,
          simulatedTs,
          raw,
        );
        if (step.args.kind === "audio.capture.started") {
          captureStarted = true;
        }
        if (step.args.kind === "audio.capture.stopped") {
          captureStopped = true;
        }
        if (step.args.kind === "zoom.meeting.joined") {
          joined = true;
        }
        continue;
      }
      if (step.action === "end") {
        explicitFinalState = (step.args.state as "completed" | "failed" | "aborted" | undefined) ?? "completed";
        if (explicitFinalState === "failed") {
          explicitError = {
            code: step.args.code ?? "simulation_failed",
            message: step.args.message ?? "Simulation ended in failure",
            fatal: true,
          };
        }
        break;
      }
    }

    if (signal.aborted) {
      throw new Error(String(signal.reason ?? "simulation_cancelled"));
    }

    if (joined) {
      await this.appendSyntheticEvent(meetingRun, "browser", "zoom.meeting.left", {
        title: scenario.title ?? `Simulated Zoom ${scenario.meeting_id}`,
        page_url: meetingRun.normalized_join_url,
        joined_at_unix_ms: simulatedTs,
      }, simulatedTs);
    }
    await emitCaptureStopped("ended");
    await this.completeSimulation(meetingRun, explicitFinalState ?? "completed", explicitError);
  }

  private handleZoomMeetingTranscript(url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return this.renderMarkdownTranscriptResponse(url, meetingRun);
  }

  private handleMarkdownTranscript(url: URL, meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    return this.renderMarkdownTranscriptResponse(url, meetingRun);
  }

  private parseTranscriptIncludes(url: URL): TranscriptIncludeKind[] | Response {
    const includeParams = url.searchParams
      .getAll("include")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (includeParams.length === 0) {
      return ["speech", "joins", "chat"];
    }
    const allowed = new Set<TranscriptIncludeKind>(["speech", "joins", "chat"]);
    const invalid = includeParams.filter((value) => !allowed.has(value as TranscriptIncludeKind));
    if (invalid.length > 0) {
      return errorResponse(400, "invalid_request", `Unsupported transcript include values: ${invalid.join(", ")}`);
    }
    return [...new Set(includeParams as TranscriptIncludeKind[])];
  }

  private parseTranscriptSinceValue(meetingRun: MeetingRunRecord, raw: string | null): number | null {
    if (!raw) {
      return null;
    }
    const absolute = parseTimestamp(raw);
    if (absolute !== null) {
      return absolute;
    }
    const meetingStartUnixMs = Date.parse(meetingRun.started_at ?? meetingRun.created_at ?? "");
    if (!Number.isFinite(meetingStartUnixMs)) {
      return null;
    }
    const match = raw.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    const third = match[3] ? Number.parseInt(match[3], 10) : null;
    const millis = match[4] ? Number.parseInt(match[4].padEnd(3, "0"), 10) : 0;
    const hours = third === null ? 0 : first;
    const minutes = third === null ? first : second;
    const seconds = third === null ? second : third;
    if (minutes > 59 || seconds > 59) {
      return null;
    }
    return meetingStartUnixMs + ((((hours * 60) + minutes) * 60 + seconds) * 1000) + millis;
  }

  private renderMarkdownTranscriptResponse(url: URL, meetingRun: MeetingRunRecord): Response {
    const includes = this.parseTranscriptIncludes(url);
    if (includes instanceof Response) {
      return includes;
    }
    const includeSet = new Set<TranscriptIncludeKind>(includes);
    const sinceParam = url.searchParams.get("since");
    const sinceUnixMs = this.parseTranscriptSinceValue(meetingRun, sinceParam);
    if (sinceParam && sinceUnixMs === null) {
      return errorResponse(400, "invalid_request", "`since` must be a parseable timestamp");
    }
    const speech = includeSet.has("speech")
      ? this.listTranscriptSpeechRecords(meetingRun.meeting_run_id)
      : [];
    const chat = includeSet.has("chat")
      ? this.listTranscriptChatRecords(meetingRun.meeting_run_id)
      : [];
    const attendeeEvents = includeSet.has("joins")
      ? [
          ...this.storage.listEventRecords({
            meeting_run_id: meetingRun.meeting_run_id,
            kind: "zoom.attendee.joined",
            limit: 10_000,
          }),
          ...this.storage.listEventRecords({
            meeting_run_id: meetingRun.meeting_run_id,
            kind: "zoom.attendee.left",
            limit: 10_000,
          }),
        ].sort((left, right) => left.event_id - right.event_id || left.seq - right.seq) as EventRecord<ZoomAttendeePresencePayload>[]
      : [];
    const markdown = this.renderMarkdownTranscript(meetingRun, speech, chat, attendeeEvents, {
      include: includes,
      since_unix_ms: sinceUnixMs,
    });
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private listTranscriptSpeechRecords(meetingRunId: string): SpeechSegmentRecord[] {
    const events = this.storage.listEventRecords({
      meeting_run_id: meetingRunId,
      kind: "transcription.segment.final",
      limit: 10_000,
    }) as EventRecord<TranscriptionSegmentPayload>[];
    const latestBySegmentId = new Map<string, SpeechSegmentRecord>();
    for (const event of events) {
      const payload = event.payload;
      const speechSegmentId = payload.speech_segment_id;
      if (!speechSegmentId) {
        continue;
      }
      latestBySegmentId.set(speechSegmentId, {
        speech_segment_id: speechSegmentId,
        event_id: event.event_id,
        meeting_run_id: event.meeting_run_id,
        room_id: event.room_id,
        provider: payload.provider,
        provider_segment_id: payload.provider_segment_id ?? null,
        text: payload.text ?? "",
        status: payload.status,
        speaker_label: payload.speaker_label ?? null,
        speaker_confidence: payload.speaker_confidence ?? null,
        started_at: payload.started_at_unix_ms ? new Date(payload.started_at_unix_ms).toISOString() : null,
        ended_at: payload.ended_at_unix_ms ? new Date(payload.ended_at_unix_ms).toISOString() : null,
        emitted_at: event.ts,
      });
    }
    return [...latestBySegmentId.values()].sort((left, right) => left.event_id - right.event_id);
  }

  private listTranscriptChatRecords(meetingRunId: string): ChatMessageRecord[] {
    const events = this.storage.listEventRecords({
      meeting_run_id: meetingRunId,
      kind: "zoom.chat.message",
      limit: 10_000,
    }) as EventRecord<ZoomChatMessagePayload>[];
    const latestByChatId = new Map<string, ChatMessageRecord>();
    for (const event of events) {
      const payload = event.payload;
      const chatMessageId = payload.chat_message_id;
      if (!chatMessageId) {
        continue;
      }
      latestByChatId.set(chatMessageId, {
        chat_message_id: chatMessageId,
        event_id: event.event_id,
        meeting_run_id: event.meeting_run_id,
        room_id: event.room_id,
        sender_display_name: payload.sender_display_name ?? null,
        sender_user_id: payload.sender_user_id ?? null,
        receiver_display_name: payload.receiver_display_name ?? null,
        receiver_user_id: payload.receiver_user_id ?? null,
        visibility: payload.visibility,
        text: payload.text ?? "",
        sent_at: payload.sent_at_unix_ms ? new Date(payload.sent_at_unix_ms).toISOString() : event.ts,
        main_chat_message_id: payload.main_chat_message_id ?? null,
        thread_reply_count: payload.thread_reply_count ?? null,
        is_thread_reply: payload.is_thread_reply,
        is_edited: payload.is_edited,
        chat_type: payload.chat_type ?? null,
        details: payload.details ?? null,
      });
    }
    return [...latestByChatId.values()].sort((left, right) => left.event_id - right.event_id);
  }

  private renderMarkdownTranscript(
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat: ChatMessageRecord[] = [],
    attendeeEvents: EventRecord<ZoomAttendeePresencePayload>[] = [],
    options?: {
      include?: TranscriptIncludeKind[];
      since_unix_ms?: number | null;
    },
  ): string {
    const includeSet = new Set<TranscriptIncludeKind>(options?.include ?? ["speech", "joins", "chat"]);
    const includeSpeech = includeSet.has("speech");
    const includeJoins = includeSet.has("joins");
    const includeChat = includeSet.has("chat");
    const sinceUnixMs = options?.since_unix_ms ?? null;
    const heading = meetingRun.room_id.startsWith("zoom:") ? meetingRun.room_id.slice(5) : meetingRun.room_id;
    const startedAt = meetingRun.started_at ?? meetingRun.created_at;
    const meetingStartUnixMs = Date.parse(startedAt ?? "");

    const formatDisplayOffset = (iso: string | null) => {
      const valueUnixMs = Date.parse(iso ?? "");
      if (!Number.isFinite(meetingStartUnixMs) || !Number.isFinite(valueUnixMs)) {
        return "??:??";
      }
      const diffMs = Math.max(0, valueUnixMs - meetingStartUnixMs);
      const totalSeconds = Math.floor(diffMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    };

    const formatMetaValue = (value: string | null | undefined) => {
      if (!value) {
        return "\"\"";
      }
      return /[\s"=\]]/.test(value) ? JSON.stringify(value) : value;
    };

    const chatRenderIds = new Map<string, number>();
    let nextChatRenderId = 1;
    for (const item of [...chat].sort((left, right) => Date.parse(left.sent_at) - Date.parse(right.sent_at) || left.event_id - right.event_id)) {
      if (!chatRenderIds.has(item.chat_message_id)) {
        chatRenderIds.set(item.chat_message_id, nextChatRenderId);
        nextChatRenderId += 1;
      }
    }

    const rawItems = [
      ...(includeSpeech ? speech : [])
        .map((segment) => {
          const text = segment.text.trim();
          if (!text) {
            return null;
          }
          return {
            kind: "speech" as const,
            sort_ts: Date.parse(segment.started_at ?? segment.emitted_at ?? segment.ended_at ?? startedAt) || 0,
            sort_index: segment.event_id,
            speaker: segment.speaker_label?.trim() || "Unknown speaker",
            display_at: segment.started_at ?? segment.emitted_at,
            updated_at: segment.emitted_at ?? segment.ended_at ?? segment.started_at ?? null,
            text,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
      ...(includeChat ? chat : [])
        .map((item, index) => ({
          kind: "chat" as const,
          sort_ts: Date.parse(item.sent_at) || 0,
          sort_index: item.event_id || index,
          chat: item,
        })),
      ...(includeJoins ? attendeeEvents : []).map((event) => ({
        kind: "presence" as const,
        sort_ts: Date.parse(event.ts) || 0,
        sort_index: event.event_id,
        event,
      })),
    ].sort((left, right) => left.sort_ts - right.sort_ts || left.sort_index - right.sort_index);

    const transcriptItems: Array<
      | {
          kind: "speech";
          sort_ts: number;
          sort_index: number;
          speaker: string;
          display_at: string | null;
          updated_at: string | null;
          text: string;
        }
      | {
          kind: "chat";
          sort_ts: number;
          sort_index: number;
          chat: ChatMessageRecord;
        }
      | {
          kind: "presence";
          sort_ts: number;
          sort_index: number;
          event: EventRecord<ZoomAttendeePresencePayload>;
        }
    > = [];

    for (const item of rawItems) {
      if (item.kind !== "speech") {
        transcriptItems.push(item);
        continue;
      }
      const previous = transcriptItems[transcriptItems.length - 1];
      if (previous && previous.kind === "speech" && item.speaker !== "Unknown speaker" && previous.speaker === item.speaker) {
        previous.text = `${previous.text}${previous.text.endsWith("-") ? "" : " "}${item.text}`.trim();
        previous.updated_at = item.updated_at ?? previous.updated_at;
        continue;
      }
      transcriptItems.push(item);
    }

    const transcriptItemDisplayUnixMs = (item: (typeof transcriptItems)[number]) => {
      if (item.kind === "speech") {
        return Date.parse(item.display_at ?? item.updated_at ?? startedAt ?? "") || 0;
      }
      if (item.kind === "chat") {
        return Date.parse(item.chat.sent_at ?? "") || 0;
      }
      return Date.parse(item.event.ts ?? "") || 0;
    };

    const filteredTranscriptItems = sinceUnixMs === null
      ? transcriptItems
      : transcriptItems.filter((item) => transcriptItemDisplayUnixMs(item) >= sinceUnixMs);

    const lines = sinceUnixMs === null
      ? [
          `# ${heading}`,
          `Meeting start: ${startedAt ?? "unknown"}`,
          `Meeting URL: ${meetingRun.normalized_join_url}`,
          "",
          "## Transcript",
          "",
          `_Defaults to \`speech,joins,chat\`. Use \`?include=${[...includeSet].join(",")}\` or any comma-separated subset to narrow it._`,
          "_Use `?since=<timestamp>` with a visible line timestamp like `00:30` to fetch from that point onward. Pagination returns complete rendered turns, so the first returned line may repeat text you already saw._",
          "",
        ]
      : [];

    if (filteredTranscriptItems.length === 0) {
      if (sinceUnixMs === null) {
        const includedKinds = [...includeSet].join(", ");
        lines.push(`_No ${includedKinds} entries yet._`);
        lines.push("");
        return lines.join("\n");
      }
      return "";
    }

    const presenceGroupWindowMs = 10_000;

    for (let index = 0; index < filteredTranscriptItems.length; index += 1) {
      const item = filteredTranscriptItems[index];
      if (item.kind === "speech") {
        lines.push(`[${formatDisplayOffset(item.display_at)} spk=${formatMetaValue(item.speaker)}] ${item.text}`);
        continue;
      }
      if (item.kind === "presence") {
        const groupedEvents = [item.event];
        const groupStartedAt = item.event.ts;
        let updatedAt = item.event.ts;
        while (index + 1 < filteredTranscriptItems.length) {
          const nextItem = filteredTranscriptItems[index + 1];
          if (nextItem.kind !== "presence") {
            break;
          }
          const sameKind = nextItem.event.kind === item.event.kind;
          const sameBackfillState = nextItem.event.payload.backfilled === item.event.payload.backfilled;
          const closeEnough = ((Date.parse(nextItem.event.ts) || 0) - (Date.parse(updatedAt) || 0)) <= presenceGroupWindowMs;
          if (!sameKind || !sameBackfillState || !closeEnough) {
            break;
          }
          groupedEvents.push(nextItem.event);
          updatedAt = nextItem.event.ts;
          index += 1;
        }
        const label = item.event.kind === "zoom.attendee.left"
          ? "leaves"
          : item.event.payload.backfilled
          ? "present"
          : "joins";
        const attendeeLabels = groupedEvents
          .map((event) => event.payload.display_name?.trim() || "Unknown attendee")
          .join(", ");
        lines.push(`[${formatDisplayOffset(groupStartedAt)} ${label}] ${attendeeLabels}`);
        continue;
      }
      const receiver = item.chat.receiver_display_name?.trim() || null;
      const renderedChatId = chatRenderIds.get(item.chat.chat_message_id);
      const renderedReplyToId = item.chat.main_chat_message_id ? chatRenderIds.get(item.chat.main_chat_message_id) : null;
      const chatTokens = [`id=${renderedChatId ?? "?"}`];
      if (renderedReplyToId) {
        chatTokens.push(`reply-to=${renderedReplyToId}`);
      } else if ((item.chat.thread_reply_count ?? 0) > 0) {
        chatTokens.push(`replies=${item.chat.thread_reply_count}`);
      }
      if (item.chat.is_edited) {
        chatTokens.push("edited=1");
      }
      lines.push(
        `[${formatDisplayOffset(item.chat.sent_at)} chat ${chatTokens.join(" ")} from=${formatMetaValue(item.chat.sender_display_name ?? "Unknown chatter")}${receiver ? ` to=${formatMetaValue(receiver)}` : ""}] ${item.chat.text}`,
      );
    }
    return lines.join("\n");
  }

  private handleListAttendees(meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    return jsonResponse(this.listResponse(this.listAttendeeSummaries(meetingRun)));
  }

  private handleZoomMeetingAttendees(url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return jsonResponse(this.listResponse(this.listAttendeeSummaries(meetingRun)));
  }

  private handleMarkdownAttendees(meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    const markdown = this.renderMarkdownAttendees(meetingRun, this.listAttendeeSummaries(meetingRun));
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private handleZoomMeetingMarkdownAttendees(url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    const markdown = this.renderMarkdownAttendees(meetingRun, this.listAttendeeSummaries(meetingRun));
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private listAttendeeSummaries(meetingRun: MeetingRunRecord): AttendeeSummaryRecord[] {
    const attendeeEvents = [
      ...this.storage.listEventRecords({
        meeting_run_id: meetingRun.meeting_run_id,
        kind: "zoom.attendee.joined",
        limit: 10_000,
      }),
      ...this.storage.listEventRecords({
        meeting_run_id: meetingRun.meeting_run_id,
        kind: "zoom.attendee.left",
        limit: 10_000,
      }),
    ].sort((left, right) => left.event_id - right.event_id || left.seq - right.seq);
    return this.buildAttendeeSummaries(meetingRun, attendeeEvents as EventRecord<ZoomAttendeePresencePayload>[]);
  }

  private buildAttendeeSummaries(
    meetingRun: MeetingRunRecord,
    attendeeEvents: EventRecord<ZoomAttendeePresencePayload>[],
  ): AttendeeSummaryRecord[] {
    const summaries = new Map<string, AttendeeSummaryRecord>();
    const pushUniqueString = (values: string[], value: string | null | undefined) => {
      const normalized = value?.trim();
      if (!normalized || values.includes(normalized)) {
        return;
      }
      values.push(normalized);
    };
    const pushUniqueNumber = (values: number[], value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value) || values.includes(value)) {
        return;
      }
      values.push(value);
    };
    const toStableKey = (payload: ZoomAttendeePresencePayload): string => {
      const displayName = payload.display_name?.trim().toLowerCase() ?? "";
      if (payload.is_guest && displayName) {
        return `guest_name:${displayName}`;
      }
      if (payload.user_id !== null && payload.user_id !== undefined) {
        return `user_id:${payload.user_id}`;
      }
      if (displayName) {
        return `display_name:${displayName}`;
      }
      const details = payload.details ?? {};
      const userGuid = typeof details.user_guid === "string" ? details.user_guid.trim() : "";
      if (userGuid) {
        return `user_guid:${userGuid}`;
      }
      const confUserId = typeof details.conf_user_id === "string" ? details.conf_user_id.trim() : "";
      if (confUserId) {
        return `conf_user_id:${confUserId}`;
      }
      const zoomId = typeof details.zoom_id === "string" ? details.zoom_id.trim() : "";
      if (zoomId) {
        return `zoom_id:${zoomId}`;
      }
      return `attendee_id:${payload.attendee_id}`;
    };

    for (const event of attendeeEvents) {
      const payload = event.payload;
      const summaryKey = toStableKey(payload);
      const existing = summaries.get(summaryKey) ?? {
        attendee_key: summaryKey,
        meeting_run_id: meetingRun.meeting_run_id,
        room_id: meetingRun.room_id,
        display_name: null,
        aliases: [],
        attendee_ids: [],
        user_ids: [],
        is_host: false,
        is_co_host: false,
        is_guest: false,
        present: false,
        join_count: 0,
        leave_count: 0,
        first_seen_at: null,
        last_seen_at: null,
      };

      pushUniqueString(existing.aliases, payload.display_name);
      pushUniqueString(existing.attendee_ids, payload.attendee_id);
      pushUniqueNumber(existing.user_ids, payload.user_id);
      existing.display_name = payload.display_name?.trim() || existing.display_name;
      existing.is_host = existing.is_host || payload.is_host;
      existing.is_co_host = existing.is_co_host || payload.is_co_host;
      existing.is_guest = existing.is_guest || payload.is_guest;
      existing.present = event.kind === "zoom.attendee.joined";
      existing.first_seen_at = existing.first_seen_at && existing.first_seen_at < event.ts ? existing.first_seen_at : event.ts;
      existing.last_seen_at = existing.last_seen_at && existing.last_seen_at > event.ts ? existing.last_seen_at : event.ts;

      if (event.kind === "zoom.attendee.joined") {
        existing.join_count += 1;
      } else {
        existing.leave_count += 1;
      }
      summaries.set(summaryKey, existing);
    }

    return Array.from(summaries.values()).sort((left, right) => {
      if (left.is_host !== right.is_host) {
        return left.is_host ? -1 : 1;
      }
      if (left.is_co_host !== right.is_co_host) {
        return left.is_co_host ? -1 : 1;
      }
      const leftName = (left.display_name ?? left.aliases[0] ?? left.attendee_key).toLowerCase();
      const rightName = (right.display_name ?? right.aliases[0] ?? right.attendee_key).toLowerCase();
      return leftName.localeCompare(rightName);
    });
  }

  private renderMarkdownAttendees(meetingRun: MeetingRunRecord, attendees: AttendeeSummaryRecord[]): string {
    const heading = meetingRun.room_id.startsWith("zoom:") ? meetingRun.room_id.slice(5) : meetingRun.room_id;
    const startedAt = meetingRun.started_at ?? meetingRun.created_at;
    const formatTimestamp = (iso: string | null) => {
      if (!iso) {
        return "Unknown time";
      }
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(iso));
    };
    const lines = [
      `# ${heading} · ${formatTimestamp(startedAt)}`,
      `Meeting URL: ${meetingRun.normalized_join_url}`,
      "",
      "## Attendees",
      "",
    ];

    if (attendees.length === 0) {
      lines.push("_No attendee presence captured yet._");
      lines.push("");
      return lines.join("\n");
    }

    for (const attendee of attendees) {
      const label = attendee.display_name ?? attendee.aliases[0] ?? "Unknown attendee";
      const tokens: string[] = [];
      if (attendee.is_host) {
        tokens.push("host");
      } else if (attendee.is_co_host) {
        tokens.push("co-host");
      }
      if (attendee.is_guest) {
        tokens.push("guest");
      }
      if (attendee.join_count > 1) {
        tokens.push(`joins=${attendee.join_count}`);
      }
      const aliases = attendee.aliases.filter((value) => value !== label);
      if (aliases.length > 0) {
        tokens.push(`aliases=${aliases.join(" / ")}`);
      }
      lines.push(`- ${label}${tokens.length ? ` [${tokens.join(", ")}]` : ""}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  private handleListChat(url: URL, meetingRunIdOverride?: string): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 250), 1000);
    const items = this.storage.listChatRecords({
      meeting_run_id: meetingRunIdOverride ?? url.searchParams.get("meeting_run_id"),
      room_id: url.searchParams.get("room_id"),
      sender_display_name: url.searchParams.get("sender_display_name"),
      receiver_display_name: url.searchParams.get("receiver_display_name"),
      q: url.searchParams.get("q"),
      from: parseTimestamp(url.searchParams.get("from")),
      to: parseTimestamp(url.searchParams.get("to")),
      limit,
    });
    return jsonResponse(this.listResponse(items));
  }

  private handleListSpeakers(url: URL, meetingRunId: string): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 500), 1000);
    return jsonResponse(this.listResponse(this.storage.listSpeakerSpans(meetingRunId, limit)));
  }

  private handleListRooms(url: URL): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 100), 500);
    return jsonResponse(this.listResponse(this.storage.listRoomRecords(limit)));
  }

  private handleSearch(url: URL): Response {
    const query = url.searchParams.get("q");
    if (!query) {
      return errorResponse(400, "invalid_request", "`q` is required");
    }
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 100), 500);
    const items = this.storage.search({
      q: query,
      meeting_run_id: url.searchParams.get("meeting_run_id"),
      room_id: url.searchParams.get("room_id"),
      from: parseTimestamp(url.searchParams.get("from")),
      to: parseTimestamp(url.searchParams.get("to")),
      limit,
    });
    return jsonResponse(this.listResponse<SearchHit>(items));
  }

  private handleListAudio(url: URL, meetingRunId: string, request: Request): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 500), 1000);
    return jsonResponse(this.listResponse(this.storage.listAudioObjects(meetingRunId, limit, this.resolvePublicBaseUrl(request))));
  }

  private handleGetAudioObject(audioObjectId: string, request: Request): Response {
    const record = this.storage.getAudioObjectRecord(audioObjectId, this.resolvePublicBaseUrl(request));
    if (!record) {
      return errorResponse(404, "not_found", "Audio object not found");
    }
    return jsonResponse({ audio_object: record });
  }

  private async handleAudioContent(audioObjectId: string, request: Request): Promise<Response> {
    const row = this.storage.getAudioObjectRow(audioObjectId);
    if (!row) {
      return errorResponse(404, "not_found", "Audio object not found");
    }
    return await serveFileContent(request, row.path, row.content_type);
  }

  private handleListArtifacts(url: URL, meetingRunId: string, request: Request): Response {
    const limit = Math.min(parseInteger(url.searchParams.get("limit"), 500), 1000);
    return jsonResponse(this.listResponse(this.storage.listArtifacts(meetingRunId, limit, this.resolvePublicBaseUrl(request))));
  }

  private async handleArtifactContent(artifactId: string, request: Request): Promise<Response> {
    const row = this.storage.getArtifactRow(artifactId);
    if (!row) {
      return errorResponse(404, "not_found", "Artifact not found");
    }
    return await serveFileContent(request, row.path, row.content_type);
  }

  private handleMinuteStream(
    request: Request,
    filters: {
      meeting_run_id: string | null;
      room_id: string | null;
    },
  ): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: (controller) => {
        const writeFrame = (eventName: string, id: string, data: unknown) => {
          const chunk = `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        };

        if (filters.meeting_run_id) {
          const minuteJob = this.getLatestMinuteJob(filters.meeting_run_id);
          const latestVersion = minuteJob ? this.storage.getLatestMinuteVersionForMinuteJob(minuteJob.minute_job_id) : null;
          if (minuteJob && latestVersion) {
            writeFrame("minutes", latestVersion.minute_version_id, {
              minute_job: minuteJob,
              version: latestVersion,
              content_markdown: latestVersion.content_markdown,
            });
          }
        }

        const subscriber: MinuteSubscriber = {
          matches: (update) => {
            if (filters.meeting_run_id && update.meeting_run_id !== filters.meeting_run_id) {
              return false;
            }
            if (filters.room_id && update.room_id !== filters.room_id) {
              return false;
            }
            return true;
          },
          send: (update) => {
            writeFrame("minutes", update.version.minute_version_id, update);
          },
          close: () => {},
        };

        const unsubscribe = this.minutesBus.subscribe(subscriber);
        const heartbeatInterval = setInterval(() => {
          writeFrame("heartbeat", "0", {
            ts: new Date().toISOString(),
          });
        }, 15_000);

        const abort = () => {
          clearInterval(heartbeatInterval);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // ignored
          }
        };

        request.signal.addEventListener("abort", abort, { once: true });
      },
      cancel: () => {},
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  private handleEventStream(
    request: Request,
    filters: {
      meeting_run_id: string | null;
      room_id: string | null;
      kind: string | null;
      source: string | null;
    },
  ): Response {
    const url = new URL(request.url);
    const afterEventId = parseInteger(
      url.searchParams.get("after_event_id") ?? request.headers.get("last-event-id"),
      0,
    );
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start: (controller) => {
        let lastEventId = afterEventId;
        let replayComplete = false;
        const bufferedRecords: EventRecord[] = [];

        const writeFrame = (eventName: string, eventId: number, data: unknown) => {
          const chunk = `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
          lastEventId = eventId;
        };

        const subscriber: SseSubscriber = {
          matches: (record) => {
            if (filters.meeting_run_id && record.meeting_run_id !== filters.meeting_run_id) {
              return false;
            }
            if (filters.room_id && record.room_id !== filters.room_id) {
              return false;
            }
            if (filters.kind && record.kind !== filters.kind) {
              return false;
            }
            if (filters.source && record.source !== filters.source) {
              return false;
            }
            return true;
          },
          send: (record) => {
            if (record.event_id <= lastEventId) {
              return;
            }
            if (!replayComplete) {
              bufferedRecords.push(record);
              return;
            }
            writeFrame("event", record.event_id, {
              event_id: record.event_id,
              event: record,
            });
          },
          close: () => {},
        };

        const unsubscribe = this.eventBus.subscribe(subscriber);
        while (true) {
          const replay = this.storage.listEventRecords({
            meeting_run_id: filters.meeting_run_id,
            room_id: filters.room_id,
            source: filters.source,
            kind: filters.kind,
            from: null,
            to: null,
            after_event_id: lastEventId,
            limit: 1000,
          });
          for (const record of replay) {
            writeFrame("event", record.event_id, {
              event_id: record.event_id,
              event: record,
            });
          }
          if (replay.length < 1000) {
            break;
          }
        }
        replayComplete = true;
        bufferedRecords
          .sort((left, right) => left.event_id - right.event_id)
          .filter((record) => record.event_id > lastEventId)
          .forEach((record) => {
            writeFrame("event", record.event_id, {
              event_id: record.event_id,
              event: record,
            });
          });
        const heartbeatInterval = setInterval(() => {
          const heartbeatId = Math.max(lastEventId, 0);
          writeFrame("heartbeat", heartbeatId, {
            event_id: heartbeatId,
            ts: new Date().toISOString(),
          });
        }, 15_000);

        const abort = () => {
          clearInterval(heartbeatInterval);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // ignored
          }
        };

        request.signal.addEventListener("abort", abort, { once: true });
      },
      cancel: () => {},
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  private handleZoomMeetingStream(request: Request, url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return this.handleEventStream(request, {
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: null,
      kind: url.searchParams.get("kind"),
      source: url.searchParams.get("source"),
    });
  }

  private handleZoomMeetingMinutesStream(request: Request, url: URL, meetingId: string): Response {
    const meetingRun = this.resolveMeetingRunForZoomMeeting(meetingId, url.searchParams.get("meeting_run_id"));
    if (!meetingRun) {
      return errorResponse(404, "not_found", "No meeting run found for this Zoom meeting id");
    }
    return this.handleMinuteStream(request, {
      meeting_run_id: meetingRun.meeting_run_id,
      room_id: null,
    });
  }

  private async handleWorkerRegister(request: Request): Promise<Response> {
    const authError = this.requireInternalAuth(request);
    if (authError) {
      return authError;
    }

    const body = await parseJsonBody<WorkerRegisterRequest>(request);
    const meetingRun = this.getMeetingRun(body.meeting_run_id);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }
    if (["completed", "failed", "aborted"].includes(meetingRun.state)) {
      return errorResponse(409, "meeting_run_terminal", "Meeting run is already in a terminal state");
    }
    const existingWorkerId = this.workersByMeetingRunId.get(body.meeting_run_id)?.worker_id ?? meetingRun.worker?.worker_id ?? null;
    if (existingWorkerId && existingWorkerId !== body.worker_id) {
      return errorResponse(409, "worker_mismatch", "Meeting run is already assigned to a different worker");
    }
    const handle = this.workersByMeetingRunId.get(body.meeting_run_id) ?? this.recoverWorkerHandle(meetingRun, body.worker_id);
    if (handle) {
      handle.worker_id = body.worker_id;
      handle.child_pid = body.pid;
      this.workersByWorkerId.set(body.worker_id, handle);
      await this.persistWorkersState();
    }
    this.storage.patchMeetingRun(body.meeting_run_id, {
      state: "starting",
      worker_id: body.worker_id,
      worker_pid: body.pid,
      ingest_port: body.ingest_port,
      cdp_port: body.cdp_port,
      started_at_unix_ms: body.started_at_unix_ms,
      updated_at_unix_ms: nowUnixMs(),
    });
    return jsonResponse({ accepted: true });
  }

  private async handleWorkerHeartbeat(request: Request, workerId: string): Promise<Response> {
    const authError = this.requireInternalAuth(request);
    if (authError) {
      return authError;
    }

    const body = await parseJsonBody<{
      meeting_run_id: string;
      state: MeetingRunRecord["state"];
      ts_unix_ms: number;
      cpu_pct?: number;
      rss_bytes?: number;
      open_ws_connections?: number;
    }>(request);
    const ownershipError = this.ensureWorkerOwnership(body.meeting_run_id, workerId);
    if (ownershipError) {
      return ownershipError;
    }

    this.storage.recordWorkerHeartbeat(workerId, body, nowUnixMs());
    this.storage.patchMeetingRun(body.meeting_run_id, {
      state: body.state,
      updated_at_unix_ms: nowUnixMs(),
    });

    const handle = this.workersByWorkerId.get(workerId) ?? this.workersByMeetingRunId.get(body.meeting_run_id);
    const claim = this.rescueClaimsByMeetingRunId.get(body.meeting_run_id);
    const response: WorkerHeartbeatResponse = {
      accepted: true,
      stop_requested: handle?.stop_requested ?? false,
      operator_assistance: claim
        ? {
            claimed: claim.claimed,
            operator: claim.operator,
            reason: claim.reason,
            note: claim.note,
            claimed_at_unix_ms: claim.claimed_at_unix_ms,
          }
        : {
            claimed: false,
            operator: null,
            reason: null,
            note: null,
            claimed_at_unix_ms: null,
          },
    };
    this.maybeStartAutomatedRescue(body.meeting_run_id);
    return jsonResponse(response);
  }

  private async handleAppendEvents(request: Request, meetingRunId: string): Promise<Response> {
    const authError = this.requireInternalAuth(request);
    if (authError) {
      return authError;
    }

    const body = await parseJsonBody<AppendEventsBatchRequest>(request);
    const ownershipError = this.ensureWorkerOwnership(meetingRunId, body.worker_id);
    if (ownershipError) {
      return ownershipError;
    }
    if (body.events.length === 0) {
      return errorResponse(400, "invalid_request", "Batch must contain at least one event");
    }
    if (body.events.some((event) => event.meeting_run_id !== meetingRunId)) {
      return errorResponse(400, "invalid_request", "Batch contained a mismatched meeting_run_id");
    }
    if (body.events.some((event) => event.room_id !== body.events[0].room_id)) {
      return errorResponse(400, "invalid_request", "Batch contained inconsistent room identifiers");
    }
    if (body.first_seq !== body.events[0].seq || body.last_seq !== body.events[body.events.length - 1].seq) {
      return errorResponse(400, "invalid_request", "Batch sequence envelope did not match contained events");
    }
    for (let index = 1; index < body.events.length; index += 1) {
      if (body.events[index].seq <= body.events[index - 1].seq) {
        return errorResponse(400, "invalid_request", "Batch event sequence must be strictly increasing");
      }
    }
    const appended = this.storage.appendEvents(body.events, nowUnixMs());
    this.patchMeetingRunFromEvents(meetingRunId, body.events);
    this.eventBus.publish(appended.records);
    this.maybeStartAutomatedRescue(meetingRunId);
    return jsonResponse({
      accepted: true,
      highest_event_id: appended.highest_event_id,
    });
  }

  private async handleWorkerComplete(request: Request, meetingRunId: string): Promise<Response> {
    const authError = this.requireInternalAuth(request);
    if (authError) {
      return authError;
    }

    const body = await parseJsonBody<CompleteMeetingRunRequest>(request);
    const ownershipError = this.ensureWorkerOwnership(meetingRunId, body.worker_id);
    if (ownershipError) {
      return ownershipError;
    }
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }

    const events: EventEnvelope[] = [];
    if (body.error) {
      events.push(this.buildCoordinatorEvent(meetingRunId, meetingRun.room_id, "error.raised", body.error, body.ended_at_unix_ms));
    }
    events.push(
      this.buildCoordinatorEvent(
        meetingRunId,
        meetingRun.room_id,
        body.final_state === "failed" ? "system.worker.failed" : "system.worker.completed",
        {
          worker_id: body.worker_id,
          final_state: body.final_state,
        },
        body.ended_at_unix_ms,
      ),
    );
    const appended = this.storage.appendEvents(events, nowUnixMs());

    this.storage.patchMeetingRun(meetingRunId, {
      state: body.final_state,
      ended_at_unix_ms: body.ended_at_unix_ms,
      updated_at_unix_ms: nowUnixMs(),
      last_error_code: body.error?.code ?? null,
      last_error_message: body.error?.message ?? null,
    });

    const handle = this.workersByWorkerId.get(body.worker_id) ?? this.workersByMeetingRunId.get(meetingRunId);
    if (handle) {
      handle.completed = true;
      this.workersByMeetingRunId.delete(meetingRunId);
      if (handle.worker_id) {
        this.workersByWorkerId.delete(handle.worker_id);
      }
      await this.persistWorkersState();
    }

    await this.stopAutomatedRescueForMeetingRun(meetingRunId, "meeting run completed");
    this.rescueClaimsByMeetingRunId.delete(meetingRunId);
    this.eventBus.publish(appended.records);
    return jsonResponse({ accepted: true });
  }

  private async handleScreenshot(meetingRunId: string): Promise<Response> {
    const record = this.storage.getMeetingRunRecord(meetingRunId);
    if (!record) {
      return errorResponse(404, "meeting_run_not_found", "Meeting run not found");
    }
    const cdpPort = record.worker?.cdp_port;
    if (!cdpPort || record.worker?.status !== "online") {
      return errorResponse(409, "no_cdp", "No active browser session for this meeting run");
    }

    try {
      const tabs = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json()) as Array<{ id: string; type: string }>;
      const tab = tabs.find((t) => t.type === "page");
      if (!tab) {
        return errorResponse(409, "no_page", "No browser page found");
      }
      const png = await this.captureScreenshotViaCDP(cdpPort, tab.id);
      return new Response(png, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(502, "screenshot_failed", `Screenshot capture failed: ${message}`);
    }
  }

  private captureScreenshotViaCDP(cdpPort: number, tabId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${tabId}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("CDP screenshot timeout"));
      }, 5000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          id: 1,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 50 },
        }));
      });

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(Buffer.from(msg.result.data, "base64"));
          }
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP connection failed"));
      });
    });
  }
}
