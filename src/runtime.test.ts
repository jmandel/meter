import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AppendEventsBatchRequest,
  BrowserCaptureStartedMessage,
  BrowserCaptureStoppedMessage,
  BrowserDomEventMessage,
  BrowserHelloMessage,
  CompleteMeetingRunRequest,
  EventEnvelope,
  InternalConfig,
  WorkerHeartbeatRequest,
  WorkerLaunchConfig,
  WorkerRegisterRequest,
} from "./domain";
import { createMeetingRunLayout } from "./files";
import { appendJsonLine, appendLogLine, getAvailablePort, sleep } from "./utils";
import { WorkerProcess } from "./worker";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

interface FakeCoordinatorState {
  registration: Deferred<WorkerRegisterRequest>;
  completion: Deferred<CompleteMeetingRunRequest>;
  registeredWorker: WorkerRegisterRequest | null;
  completedRun: CompleteMeetingRunRequest | null;
  events: EventEnvelope[];
  heartbeats: WorkerHeartbeatRequest[];
}

interface FakeCoordinator {
  server: Bun.Server;
  baseUrl: string;
  state: FakeCoordinatorState;
}

interface FakeMistralState {
  sessionReady: Deferred<void>;
  appendCount: number;
  flushCount: number;
  endCount: number;
  doneCount: number;
}

interface FakeMistralServer {
  server: Bun.Server;
  wsUrl: string;
  state: FakeMistralState;
}

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_REALTIME_WS_URL;
  delete process.env.MISTRAL_REALTIME_MODEL;
  delete process.env.MISTRAL_STREAMING_DELAY_MS;
  delete process.env.METER_DISABLE_BROWSER_AUTOMATION;

  while (tempDirs.length > 0) {
    const dirPath = tempDirs.pop();
    if (!dirPath) {
      continue;
    }
    await rm(dirPath, { force: true, recursive: true });
  }
});

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function buildPcmFrame(streamSeq: number, tsUnixMs: number, sampleRateHz: number, sampleCount = 320): Uint8Array {
  const payload = new Uint8Array(sampleCount * 2);
  const frame = new Uint8Array(28 + payload.byteLength);
  frame.set(Buffer.from("ZPCM", "ascii"), 0);
  const view = new DataView(frame.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, streamSeq, true);
  view.setBigUint64(12, BigInt(tsUnixMs), true);
  view.setUint32(20, sampleRateHz, true);
  view.setUint32(24, payload.byteLength, true);
  frame.set(payload, 28);
  return frame;
}

async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`Failed to open websocket ${url}`)), { once: true });
  });
}

async function startFakeCoordinator(token: string): Promise<FakeCoordinator> {
  const port = await getAvailablePort();
  const state: FakeCoordinatorState = {
    registration: createDeferred<WorkerRegisterRequest>(),
    completion: createDeferred<CompleteMeetingRunRequest>(),
    registeredWorker: null,
    completedRun: null,
    events: [],
    heartbeats: [],
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }

      const url = new URL(request.url);
      if (url.pathname === "/internal/v1/workers/register" && request.method === "POST") {
        const body = (await request.json()) as WorkerRegisterRequest;
        state.registeredWorker = body;
        state.registration.resolve(body);
        return Response.json({ accepted: true });
      }

      const heartbeatMatch = url.pathname.match(/^\/internal\/v1\/workers\/([^/]+)\/heartbeat$/);
      if (heartbeatMatch && request.method === "POST") {
        const body = (await request.json()) as WorkerHeartbeatRequest;
        state.heartbeats.push(body);
        return Response.json({ accepted: true, stop_requested: false });
      }

      const batchMatch = url.pathname.match(/^\/internal\/v1\/meeting-runs\/([^/]+)\/events:batch$/);
      if (batchMatch && request.method === "POST") {
        const body = (await request.json()) as AppendEventsBatchRequest;
        state.events.push(...body.events);
        return Response.json({ accepted: true, highest_event_id: state.events.length });
      }

      const completeMatch = url.pathname.match(/^\/internal\/v1\/meeting-runs\/([^/]+)\/complete$/);
      if (completeMatch && request.method === "POST") {
        const body = (await request.json()) as CompleteMeetingRunRequest;
        state.completedRun = body;
        state.completion.resolve(body);
        return Response.json({ accepted: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
  };
}

async function startFakeMistralServer(): Promise<FakeMistralServer> {
  const port = await getAvailablePort();
  const state: FakeMistralState = {
    sessionReady: createDeferred<void>(),
    appendCount: 0,
    flushCount: 0,
    endCount: 0,
    doneCount: 0,
  };

  const server = Bun.serve<{
    sentDelta: boolean;
    sentFinal: boolean;
  }>({
    hostname: "127.0.0.1",
    port,
    fetch(request, wsServer) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/audio/transcriptions/realtime") {
        return new Response("not found", { status: 404 });
      }
      const upgraded = wsServer.upgrade(request, {
        data: {
          sentDelta: false,
          sentFinal: false,
        },
      });
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const rawText =
          typeof message === "string"
            ? message
            : Buffer.from(message as ArrayBuffer | Uint8Array).toString("utf8");
        const payload = JSON.parse(rawText) as { type?: string; audio?: string };
        switch (payload.type) {
          case "session.update":
            ws.send(
              JSON.stringify({
                type: "session.created",
                session: {
                  request_id: "fake-session-1",
                  model: "fake-model",
                  audio_format: {
                    encoding: "pcm_s16le",
                    sample_rate: 16000,
                  },
                },
              }),
            );
            state.sessionReady.resolve();
            break;
          case "input_audio.append":
            state.appendCount += 1;
            if (!ws.data.sentDelta) {
              ws.data.sentDelta = true;
              ws.send(JSON.stringify({ type: "transcription.text.delta", text: "hello world" }));
            }
            break;
          case "input_audio.flush":
            state.flushCount += 1;
            if (!ws.data.sentFinal) {
              ws.data.sentFinal = true;
              ws.send(
                JSON.stringify({
                  type: "transcription.segment",
                  text: "hello world",
                  start: 0,
                  end: 0.25,
                  speaker_id: null,
                }),
              );
              state.doneCount += 1;
              ws.send(JSON.stringify({ type: "transcription.done", text: "hello world", segments: [] }));
            }
            break;
          case "input_audio.end":
            state.endCount += 1;
            state.doneCount += 1;
            ws.send(JSON.stringify({ type: "transcription.done", segments: [] }));
            setTimeout(() => ws.close(), 10);
            break;
          default:
            break;
        }
      },
    },
  });

  return {
    server,
    wsUrl: `ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`,
    state,
  };
}

function buildWorkerLaunchConfig(
  coordinatorBaseUrl: string,
  coordinatorToken: string,
  dataRoot: string,
  paths: WorkerLaunchConfig["paths"],
): WorkerLaunchConfig {
  const app: InternalConfig = {
    mode: "worker",
    public_base_url: coordinatorBaseUrl,
    listen_host: "127.0.0.1",
    listen_port: 0,
    data_root: dataRoot,
    chrome_bin: "/usr/bin/chromium",
    default_bot_name: "Meeting Bot",
    transcription_provider: "mistral",
    persist_live_pcm: true,
    persist_archive_audio: true,
    archive_chunk_ms: 5000,
    live_pcm_chunk_ms: 480,
    sqlite_path: path.join(dataRoot, "index.sqlite"),
    coordinator_base_url: coordinatorBaseUrl,
    coordinator_token: coordinatorToken,
    heartbeat_interval_ms: 10_000,
  };

  return {
    app,
    meeting_run_id: "meeting-run-test",
    room_id: "room-test",
    normalized_join_url: "https://zoom.us/j/123456789",
    bot_name: "Meeting Bot",
    requested_by: "test",
    tags: ["test"],
    options: {
      open_chat_panel: true,
      enable_transcription: true,
      enable_speaker_tracking: true,
      enable_chat_tracking: true,
      persist_archive_audio: true,
      persist_live_pcm: true,
      archive_chunk_ms: 5000,
      live_pcm_chunk_ms: 480,
      auto_stop_when_meeting_ends: true,
    },
    paths,
    browser_token: "browser-token-test",
  };
}

test("append helpers append instead of overwriting", async () => {
  const dirPath = await createTempDir("meter-utils-");
  const jsonPath = path.join(dirPath, "events.ndjson");
  const logPath = path.join(dirPath, "worker.log");

  await appendJsonLine(jsonPath, { seq: 1, text: "first" });
  await appendJsonLine(jsonPath, { seq: 2, text: "second" });
  await appendLogLine(logPath, "first line");
  await appendLogLine(logPath, "second line");

  const jsonLines = await readJsonLines<{ seq: number; text: string }>(jsonPath);
  const logLines = (await readFile(logPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  expect(jsonLines).toEqual([
    { seq: 1, text: "first" },
    { seq: 2, text: "second" },
  ]);
  expect(logLines).toHaveLength(2);
  expect(logLines[0]).toEndWith("first line");
  expect(logLines[1]).toEndWith("second line");
});

test("worker streams realtime Mistral transcripts and persists raw plus derived lines", async () => {
  const dataRoot = await createTempDir("meter-worker-");
  const coordinatorToken = "coordinator-token-test";
  const coordinator = await startFakeCoordinator(coordinatorToken);
  const mistral = await startFakeMistralServer();

  process.env.MISTRAL_API_KEY = "dummy-key";
  process.env.MISTRAL_REALTIME_WS_URL = mistral.wsUrl;
  process.env.MISTRAL_REALTIME_MODEL = "fake-model";
  process.env.MISTRAL_STREAMING_DELAY_MS = "50";
  process.env.METER_DISABLE_BROWSER_AUTOMATION = "1";

  try {
    const layout = await createMeetingRunLayout(dataRoot, "meeting-run-test", 1_710_000_000_000, true);
    const launch = buildWorkerLaunchConfig(coordinator.baseUrl, coordinatorToken, dataRoot, layout);
    const worker = new WorkerProcess(launch);
    const workerPromise = worker.start();

    const registration = await Promise.race([
      coordinator.state.registration.promise,
      sleep(2_000).then(() => {
        throw new Error("Worker did not register");
      }),
    ]);

    const browserWs = await openWebSocket(
      `ws://127.0.0.1:${registration.ingest_port}/internal/browser/session?token=${launch.browser_token}`,
    );

    const baseTs = 1_710_000_100_000;
    const hello: BrowserHelloMessage = {
      type: "hello",
      page_url: "https://zoom.us/j/123456789",
      user_agent: "bun-test",
      ts_unix_ms: baseTs,
    };
    const captureStarted: BrowserCaptureStartedMessage = {
      type: "capture.started",
      archive_stream_id: "archive-1",
      live_stream_id: "live-1",
      archive_content_type: "audio/mpeg",
      archive_codec: "mp3",
      pcm_sample_rate_hz: 16_000,
      pcm_channels: 1,
      ts_unix_ms: baseTs + 5,
    };
    const captureStopped: BrowserCaptureStoppedMessage = {
      type: "capture.stopped",
      reason: "ended",
      ts_unix_ms: baseTs + 2_000,
    };
    const speakerActive: BrowserDomEventMessage = {
      type: "dom.event",
      event: {
        meeting_run_id: "meeting-run-test",
        room_id: "room-test",
        seq: 0,
        source: "zoom_dom",
        kind: "zoom.speaker.active",
        ts_unix_ms: baseTs + 8,
        payload: {
          speaker_display_name: "Speaker One",
        },
      },
    };

    browserWs.send(JSON.stringify(hello));
    browserWs.send(JSON.stringify(captureStarted));
    browserWs.send(JSON.stringify(speakerActive));
    await Promise.race([
      mistral.state.sessionReady.promise,
      sleep(2_000).then(() => {
        throw new Error("Mistral session was not established");
      }),
    ]);

    browserWs.send(buildPcmFrame(1, baseTs + 10, 16_000));
    browserWs.send(buildPcmFrame(2, baseTs + 510, 16_000));
    await sleep(100);
    browserWs.send(JSON.stringify(captureStopped));

    await Promise.race([
      coordinator.state.completion.promise,
      sleep(4_000).then(() => {
        throw new Error("Worker did not complete");
      }),
    ]);
    await workerPromise;

    const eventKinds = coordinator.state.events.map((event) => event.kind);
    expect(eventKinds).toEqual(
      expect.arrayContaining([
        "transcription.session.started",
        "transcription.segment.partial",
        "transcription.segment.final",
        "transcription.session.stopped",
      ]),
    );

    const partialEvent = coordinator.state.events.find((event) => event.kind === "transcription.segment.partial");
    const finalEvent = coordinator.state.events.find(
      (event) =>
        event.kind === "transcription.segment.final" &&
        typeof (event.payload as { started_at_unix_ms?: number | null }).started_at_unix_ms === "number",
    );
    const sessionStoppedIndex = coordinator.state.events.findIndex((event) => event.kind === "transcription.session.stopped");
    const captureStoppedIndex = coordinator.state.events.findIndex((event) => event.kind === "audio.capture.stopped");
    expect(partialEvent?.payload).toMatchObject({
      text: "hello world",
      status: "partial",
      started_at_unix_ms: baseTs + 10,
    });
    expect(finalEvent?.payload).toMatchObject({
      text: "hello world",
      status: "final",
      started_at_unix_ms: baseTs + 10,
      ended_at_unix_ms: baseTs + 260,
      speaker_label: "Speaker One",
    });
    expect(sessionStoppedIndex).toBeGreaterThan(captureStoppedIndex);

    const providerRawLines = await readJsonLines<{ payload: { type: string } }>(layout.transcripts_provider_raw_path);
    const segmentLines = await readJsonLines<{
      text: string;
      status: "partial" | "final";
      started_at_unix_ms: number | null;
      ended_at_unix_ms: number | null;
      speaker_label: string | null;
    }>(layout.transcripts_segments_path);

    const providerTypes = providerRawLines.map((line) => line.payload.type);
    expect(providerTypes).toEqual(
      expect.arrayContaining([
        "session.created",
        "transcription.text.delta",
        "transcription.segment",
        "transcription.done",
      ]),
    );
    expect(providerTypes.filter((type) => type === "transcription.done")).toHaveLength(2);
    expect(segmentLines.length).toBeGreaterThanOrEqual(2);
    const partialLine = segmentLines.find((line) => line.status === "partial" && line.text === "hello world");
    const finalLine = segmentLines.find(
      (line) =>
        line.status === "final" &&
        line.text === "hello world" &&
        typeof line.started_at_unix_ms === "number" &&
        typeof line.ended_at_unix_ms === "number",
    );
    expect(partialLine).toMatchObject({
      text: "hello world",
      status: "partial",
      started_at_unix_ms: baseTs + 10,
      ended_at_unix_ms: null,
      speaker_label: null,
    });
    expect(finalLine).toMatchObject({
      text: "hello world",
      status: "final",
      started_at_unix_ms: baseTs + 10,
      ended_at_unix_ms: baseTs + 260,
      speaker_label: null,
    });

    expect(mistral.state.appendCount).toBeGreaterThanOrEqual(2);
    expect(mistral.state.flushCount).toBeGreaterThanOrEqual(1);
    expect(mistral.state.endCount).toBeGreaterThanOrEqual(1);
    expect(mistral.state.doneCount).toBe(2);
  } finally {
    coordinator.server.stop(true);
    mistral.server.stop(true);
  }
});

test("worker writes a single MP3 archive from backend-owned PCM capture", async () => {
  const dataRoot = await createTempDir("meter-archive-");
  const coordinatorToken = "coordinator-token-archive";
  const coordinator = await startFakeCoordinator(coordinatorToken);

  process.env.METER_DISABLE_BROWSER_AUTOMATION = "1";

  try {
    const layout = await createMeetingRunLayout(dataRoot, "meeting-run-test", 1_710_000_000_000, false);
    const launch = buildWorkerLaunchConfig(coordinator.baseUrl, coordinatorToken, dataRoot, layout);
    launch.app.transcription_provider = "none";
    launch.options.enable_transcription = false;
    launch.app.persist_live_pcm = false;
    launch.options.persist_live_pcm = false;

    const worker = new WorkerProcess(launch);
    const workerPromise = worker.start();

    const registration = await Promise.race([
      coordinator.state.registration.promise,
      sleep(2_000).then(() => {
        throw new Error("Worker did not register");
      }),
    ]);

    const browserWs = await openWebSocket(
      `ws://127.0.0.1:${registration.ingest_port}/internal/browser/session?token=${launch.browser_token}`,
    );

    const baseTs = 1_710_000_200_000;
    const hello: BrowserHelloMessage = {
      type: "hello",
      page_url: "https://zoom.us/j/123456789",
      user_agent: "bun-test",
      ts_unix_ms: baseTs,
    };
    const captureStarted: BrowserCaptureStartedMessage = {
      type: "capture.started",
      archive_stream_id: "archive-1",
      live_stream_id: "live-1",
      archive_content_type: "audio/mpeg",
      archive_codec: "mp3",
      pcm_sample_rate_hz: 16_000,
      pcm_channels: 1,
      ts_unix_ms: baseTs + 5,
    };
    const captureStopped: BrowserCaptureStoppedMessage = {
      type: "capture.stopped",
      reason: "ended",
      ts_unix_ms: baseTs + 2_000,
    };

    browserWs.send(JSON.stringify(hello));
    browserWs.send(JSON.stringify(captureStarted));
    for (let index = 0; index < 8; index += 1) {
      browserWs.send(buildPcmFrame(index + 1, baseTs + 10 + index * 200, 16_000, 3_200));
    }
    browserWs.send(JSON.stringify(captureStopped));

    await Promise.race([
      coordinator.state.completion.promise,
      sleep(4_000).then(() => {
        throw new Error("Worker did not complete");
      }),
    ]);
    await workerPromise;

    const manifest = JSON.parse(await readFile(layout.archive_manifest_path, "utf8")) as {
      chunks: Array<{
        chunk_seq: number;
        byte_length: number;
        sha256_hex: string | null;
        path: string;
      }>;
    };
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0]).toMatchObject({
      chunk_seq: 1,
      path: path.join(layout.archive_audio_dir, "meeting.mp3"),
      sha256_hex: null,
    });
    expect(manifest.chunks[0].byte_length).toBeGreaterThan(0);

    const archiveFile = Bun.file(path.join(layout.archive_audio_dir, "meeting.mp3"));
    expect(await archiveFile.exists()).toBe(true);
    expect(archiveFile.size).toBeGreaterThan(0);

    const archiveEvent = coordinator.state.events.find((event) => event.kind === "audio.archive.chunk_written");
    expect(archiveEvent?.payload).toMatchObject({
      stream_kind: "archive",
      chunk_seq: 1,
      content_type: "audio/mpeg",
      codec: "mp3",
      path: path.join(layout.archive_audio_dir, "meeting.mp3"),
    });
    expect(coordinator.state.events.filter((event) => event.kind === "audio.live_pcm.chunk_written")).toHaveLength(0);
  } finally {
    coordinator.server.stop(true);
  }
});
