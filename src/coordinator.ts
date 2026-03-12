import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import dashboard from "../ui/index.html";

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
  WorkerLaunchConfig,
  WorkerHeartbeatResponse,
  WorkerRegisterRequest,
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

interface SseSubscriber {
  send(record: EventRecord): void;
  matches(record: EventRecord): boolean;
  close(): void;
}

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
  private readonly workersByMeetingRunId = new Map<string, WorkerHandle>();
  private readonly workersByWorkerId = new Map<string, WorkerHandle>();
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
    this.server = Bun.serve({
      hostname: this.config.listen_host,
      port: this.config.listen_port,
      routes: {
        "/": dashboard,
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
      if (url.pathname === "/v1/stream" && request.method === "GET") {
        return this.handleEventStream(request, { room_id: url.searchParams.get("room_id"), meeting_run_id: url.searchParams.get("meeting_run_id"), kind: url.searchParams.get("kind"), source: url.searchParams.get("source") });
      }

      let match = url.pathname.match(/^\/v1\/meeting-runs\/([^/]+)$/);
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
    for (const handle of activeHandles) {
      handle.stop_requested = true;
    }
    await this.persistWorkersState();
    await Promise.allSettled([
      ...activeHandles.map((handle) => this.terminateWorker(handle)),
      ...Array.from(this.automatedRescueAttemptsByMeetingRunId.keys()).map((meetingRunId) =>
        this.stopAutomatedRescueForMeetingRun(meetingRunId, "coordinator stopping"),
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

  private async handleCreateMeetingRun(request: Request): Promise<Response> {
    const body = await parseJsonBody<CreateMeetingRunRequest>(request);
    if (!body.join_url) {
      return errorResponse(400, "invalid_request", "`join_url` is required");
    }

    const now = nowUnixMs();
    const normalized = normalizeZoomJoinUrl(body.join_url);
    const actualMeetingRunId = uuidv7(now);
    const options = buildMeetingRunOptions(this.config, body.options);
    const layout = await createMeetingRunLayout(this.config.data_root, actualMeetingRunId, now, options.persist_live_pcm);
    const metadata = {
      meeting_run_id: actualMeetingRunId,
      room_id: normalized.room_id,
      normalized_join_url: normalized.normalized_join_url,
      requested_by: body.requested_by ?? null,
      bot_name: body.bot_name?.trim() || this.config.default_bot_name,
      created_at_unix_ms: now,
      tags: body.tags ?? [],
      options,
    };
    await writeMeetingMetadata(layout, metadata);
    await writeMeetingLifecycle(layout, buildLifecycleFile(actualMeetingRunId, "pending", now));

    this.storage.upsertRoom({
      room_id: normalized.room_id,
      provider_room_key: normalized.provider_room_key,
      normalized_join_url: normalized.normalized_join_url,
      display_name: null,
      now_unix_ms: now,
    });
    this.storage.insertMeetingRun({
      meeting_run_id: actualMeetingRunId,
      room_id: normalized.room_id,
      normalized_join_url: normalized.normalized_join_url,
      requested_by: body.requested_by ?? null,
      bot_name: body.bot_name?.trim() || this.config.default_bot_name,
      state: "pending",
      created_at_unix_ms: now,
      data_dir: layout.data_dir,
      tags: body.tags ?? [],
      options,
      paths: layout,
    });

    const createdEvent = this.buildCoordinatorEvent(actualMeetingRunId, normalized.room_id, "system.meeting_run.created", {
      join_url: normalized.normalized_join_url,
      requested_by: body.requested_by ?? null,
      tags: body.tags ?? [],
    }, now);
    const appended = this.storage.appendEvents([createdEvent], now);
    this.eventBus.publish(appended.records);

    const workerLaunchConfig: WorkerLaunchConfig = {
      app: this.config,
      meeting_run_id: actualMeetingRunId,
      room_id: normalized.room_id,
      normalized_join_url: normalized.normalized_join_url,
      bot_name: body.bot_name?.trim() || this.config.default_bot_name,
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

    const meetingRun = this.storage.getMeetingRunRecord(actualMeetingRunId);
    return jsonResponse({ meeting_run: meetingRun }, { status: 201 });
  }

  private async spawnWorker(launchConfig: WorkerLaunchConfig): Promise<void> {
    const entryScript = path.resolve(new URL("../server.ts", import.meta.url).pathname);
    const child = Bun.spawn([process.execPath, entryScript, "--mode", "worker"], {
      cwd: path.dirname(entryScript),
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        ZOOMER_WORKER_CONFIG_B64: encodeBase64Json(launchConfig),
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
    const handle =
      this.workersByMeetingRunId.get(meetingRunId) ??
      (record.worker?.worker_id ? this.recoverWorkerHandle(record, record.worker.worker_id) : null);
    if (!handle || !record.worker?.worker_id) {
      return errorResponse(409, "worker_unavailable", "No worker is available to stop this meeting run");
    }
    if (handle.stop_requested) {
      return jsonResponse({
        meeting_run_id: meetingRunId,
        accepted: true,
      });
    }
    handle.stop_requested = true;
    this.rescueClaimsByMeetingRunId.delete(meetingRunId);
    void this.stopAutomatedRescueForMeetingRun(meetingRunId, "stop requested");
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

  private async renderAutomatedRescuePrompt(meetingRun: MeetingRunRecord, rescueStatus: RescueStatusResponse): Promise<string> {
    const template = await this.loadRescuePromptTemplate();
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
        rescue_status: rescueStatus,
        meeting_run: meetingRun,
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
    const prompt = await this.renderAutomatedRescuePrompt(meetingRun, rescueStatus);
    const context = {
      generated_at: new Date().toISOString(),
      command: this.automatedRescueConfig.command,
      operator_name: this.automatedRescueConfig.operator_name,
      rescue_status: rescueStatus,
      meeting_run: meetingRun,
    };
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
        env: {
          ...process.env,
          METER_BASE_URL: this.rescueBaseUrl(),
          METER_MEETING_RUN_ID: meetingRun.meeting_run_id,
          METER_ROOM_ID: meetingRun.room_id,
          METER_OPERATOR_NAME: this.automatedRescueConfig.operator_name,
          METER_TIMEOUT_BUDGET: String(this.automatedRescueConfig.timeout_ms),
          METER_JOIN_URL: meetingRun.normalized_join_url,
          METER_RESCUE_STATUS_JSON: JSON.stringify(rescueStatus),
          METER_RESCUE_PROMPT_PATH: promptPath,
          METER_RESCUE_CONTEXT_PATH: contextPath,
          METER_RESCUE_LOG_PATH: logPath,
        },
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

  private handleMarkdownTranscript(url: URL, meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }

    const includeParams = url.searchParams
      .getAll("include")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const includeChat = parseBoolean(url.searchParams.get("chat") ?? undefined, false) || includeParams.includes("chat");
    const speech = this.storage.listSpeechRecords({
      meeting_run_id: meetingRunId,
      status: "final",
      limit: 10_000,
    });
    const chat = includeChat
      ? this.storage.listChatRecords({
          meeting_run_id: meetingRunId,
          limit: 10_000,
        })
      : [];
    const markdown = this.renderMarkdownTranscript(meetingRun, speech, chat, includeChat);
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private renderMarkdownTranscript(
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat: ChatMessageRecord[] = [],
    includeChat = false,
  ): string {
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

    const grouped: Array<{ speaker: string; started_at: string | null; text: string }> = [];
    for (const segment of speech) {
      const text = segment.text.trim();
      if (!text) {
        continue;
      }
      const speaker = segment.speaker_label?.trim() || "Unknown speaker";
      const startedAtIso = segment.started_at ?? segment.emitted_at;
      const previous = grouped[grouped.length - 1];
      if (previous && speaker !== "Unknown speaker" && previous.speaker === speaker) {
        previous.text = `${previous.text}${previous.text.endsWith("-") ? "" : " "}${text}`.trim();
        continue;
      }
      grouped.push({
        speaker,
        started_at: startedAtIso,
        text,
      });
    }

    const lines = [
      `# ${heading} · ${formatTimestamp(startedAt)}`,
      `Meeting URL: ${meetingRun.normalized_join_url}`,
      "",
      "## Transcript",
      "",
    ];

    if (grouped.length === 0) {
      if (!includeChat || chat.length === 0) {
        lines.push("_No finalized transcript yet._");
        lines.push("");
        return lines.join("\n");
      }
    }

    if (!includeChat) {
      for (const item of grouped) {
        lines.push(`### ${formatTimestamp(item.started_at)} · ${item.speaker}`);
        lines.push("");
        lines.push(item.text);
        lines.push("");
      }
      return lines.join("\n");
    }

    const chatRenderIds = new Map<string, number>();
    let nextChatRenderId = 1;
    for (const item of [...chat].sort((left, right) => Date.parse(left.sent_at) - Date.parse(right.sent_at) || left.event_id - right.event_id)) {
      if (!chatRenderIds.has(item.chat_message_id)) {
        chatRenderIds.set(item.chat_message_id, nextChatRenderId);
        nextChatRenderId += 1;
      }
    }

    const transcriptItems = [
      ...grouped.map((item, index) => ({
        kind: "speech" as const,
        sort_ts: Date.parse(item.started_at ?? startedAt) || 0,
        sort_index: index,
        speaker: item.speaker,
        started_at: item.started_at,
        text: item.text,
      })),
      ...chat
        .filter((item) => item.text.trim())
        .map((item, index) => ({
          kind: "chat" as const,
          sort_ts: Date.parse(item.sent_at) || 0,
          sort_index: index,
          chat: item,
        })),
    ].sort((left, right) => left.sort_ts - right.sort_ts || left.sort_index - right.sort_index || (left.kind === "speech" ? -1 : 1));

    if (transcriptItems.length === 0) {
      lines.push("_No finalized transcript or chat yet._");
      lines.push("");
      return lines.join("\n");
    }

    for (const item of transcriptItems) {
      if (item.kind === "speech") {
        lines.push(`### ${formatTimestamp(item.started_at)} · ${item.speaker}`);
        lines.push("");
        lines.push(item.text);
        lines.push("");
        continue;
      }
      const receiver = item.chat.receiver_display_name?.trim() || null;
      const chatLabel = receiver ? `${item.chat.sender_display_name ?? "Unknown chatter"} -> ${receiver}` : (item.chat.sender_display_name ?? "Unknown chatter");
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
      lines.push(`### ${formatTimestamp(item.chat.sent_at)} · [chat ${chatTokens.join(" ")}] ${chatLabel}`);
      lines.push("");
      lines.push(item.chat.text);
      lines.push("");
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
