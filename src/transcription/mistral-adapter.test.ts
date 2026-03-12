import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AudioCaptureStartedPayload, EventSourceKind, EventKind } from "../domain";
import { getAvailablePort, sleep } from "../utils";
import { MistralRealtimeTranscriptionAdapter } from "./mistral-adapter";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.MISTRAL_REALTIME_WS_URL;
  delete process.env.MISTRAL_REALTIME_MODEL;
  while (tempDirs.length > 0) {
    const dirPath = tempDirs.pop();
    if (!dirPath) {
      continue;
    }
    await rm(dirPath, { force: true, recursive: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

test("mistral adapter can reconnect after the websocket closes unexpectedly", async () => {
  const port = await getAvailablePort();
  const connections: WebSocket[] = [];
  let connectionCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, websocketServer) {
      return websocketServer.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections.push(ws as unknown as WebSocket);
        connectionCount += 1;
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : Buffer.from(message as ArrayBuffer | Uint8Array).toString("utf8");
        const payload = JSON.parse(text) as { type?: string };
        if (payload.type === "session.update") {
          ws.send(JSON.stringify({
            type: "session.created",
            session: {
              request_id: `request-${connectionCount}`,
              model: "fake-model",
              audio_format: {
                encoding: "pcm_s16le",
                sample_rate: 16_000,
              },
            },
          }));
        }
      },
    },
  });

  const dirPath = await createTempDir("meter-mistral-adapter-");
  process.env.MISTRAL_REALTIME_WS_URL = `ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`;
  process.env.MISTRAL_REALTIME_MODEL = "fake-model";

  const emittedKinds: EventKind[] = [];
  const adapter = new MistralRealtimeTranscriptionAdapter({
    apiKey: "test-key",
    meetingRunId: "meeting-run-test",
    roomId: "room-test",
    providerRawPath: path.join(dirPath, "provider_raw.ndjson"),
    segmentsPath: path.join(dirPath, "segments.jsonl"),
    callbacks: {
      emitEvent: async (_source: EventSourceKind, kind: EventKind) => {
        emittedKinds.push(kind);
      },
      appendProviderRaw: async () => {},
      appendSegment: async () => {},
      raiseError: async () => {},
      log: async () => {},
    },
  });

  const payload: AudioCaptureStartedPayload = {
    archive_stream_id: "archive-1",
    live_stream_id: "live-1",
    archive_content_type: "audio/mpeg",
    archive_codec: "mp3",
    pcm_sample_rate_hz: 16_000,
    pcm_channels: 1,
  };

  try {
    await adapter.start(payload);
    await sleep(50);
    expect(connectionCount).toBe(1);
    connections[0]?.close();
    await sleep(100);

    await adapter.start(payload);
    await sleep(50);
    expect(connectionCount).toBe(2);
    expect(emittedKinds.filter((kind) => kind === "transcription.session.started")).toHaveLength(2);
  } finally {
    server.stop(true);
    await adapter.stop("test_done");
  }
});
