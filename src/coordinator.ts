import path from "node:path";

import dashboard from "../ui/index.html";

import type {
  AppendEventsBatchRequest,
  AppConfig,
  CompleteMeetingRunRequest,
  CreateMeetingRunRequest,
  EventEnvelope,
  EventRecord,
  HealthResponse,
  InternalConfig,
  ListResponse,
  MeetingRunOptions,
  MeetingRunRecord,
  SearchHit,
  SpeechSegmentRecord,
  WorkerLaunchConfig,
  WorkerRegisterRequest,
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
  private server?: Bun.Server;
  private coordinatorLogPath = "";
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly config: InternalConfig) {
  }

  async start(): Promise<void> {
    const layout = await ensureCoordinatorLayout(this.config.data_root);
    this.coordinatorLogPath = layout.coordinator_log_path;
    this.storage = new AppDatabase(this.config);
    this.storage.init();
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
        return this.handleMarkdownTranscript(match[1]);
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
    await Promise.allSettled(activeHandles.map((handle) => this.terminateWorker(handle)));
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

  private handleMarkdownTranscript(meetingRunId: string): Response {
    const meetingRun = this.getMeetingRun(meetingRunId);
    if (!meetingRun) {
      return errorResponse(404, "not_found", "Meeting run not found");
    }

    const speech = this.storage.listSpeechRecords({
      meeting_run_id: meetingRunId,
      status: "final",
      limit: 10_000,
    });
    const markdown = this.renderMarkdownTranscript(meetingRun, speech);
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private renderMarkdownTranscript(meetingRun: MeetingRunRecord, speech: SpeechSegmentRecord[]): string {
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
      `# Zoom ${heading}`,
      "",
      `Started: ${formatTimestamp(startedAt)}`,
      `Meeting URL: ${meetingRun.normalized_join_url}`,
      "",
      "## Transcript",
      "",
    ];

    if (grouped.length === 0) {
      lines.push("_No finalized transcript yet._");
      lines.push("");
      return lines.join("\n");
    }

    for (const item of grouped) {
      lines.push(`### ${formatTimestamp(item.started_at)} · ${item.speaker}`);
      lines.push("");
      lines.push(item.text);
      lines.push("");
    }

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
    return jsonResponse({
      accepted: true,
      stop_requested: handle?.stop_requested ?? false,
    });
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
