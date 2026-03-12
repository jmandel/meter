import { createHash } from "node:crypto";

import type {
  AudioCaptureStartedPayload,
  ErrorRaisedPayload,
  TranscriptionProvider,
  TranscriptionSegmentPayload,
} from "../domain";
import { appendJsonLine, nowUnixMs, sleep, uuidv7 } from "../utils";
import {
  buildSegmentRecord,
  buildSessionStartedPayload,
  type RealtimeAudioFrame,
  type TranscriptionAdapter,
  type TranscriptionAdapterCallbacks,
} from "./adapter";

function getRealtimeModel(): string {
  return process.env.MISTRAL_REALTIME_MODEL || "voxtral-mini-transcribe-realtime-2602";
}

function getStreamingDelayMs(): number {
  return Number.parseInt(process.env.MISTRAL_STREAMING_DELAY_MS || "250", 10);
}

function getRealtimeWsUrl(): string {
  return process.env.MISTRAL_REALTIME_WS_URL || "wss://api.mistral.ai/v1/audio/transcriptions/realtime";
}

interface MistralAdapterOptions {
  apiKey: string;
  meetingRunId: string;
  roomId: string;
  providerRawPath: string;
  segmentsPath: string;
  callbacks: TranscriptionAdapterCallbacks;
}

interface MistralSessionState {
  request_id: string;
  model: string;
  audio_format: {
    encoding: string;
    sample_rate: number;
  };
  target_streaming_delay_ms?: number | null;
}

function buildSegmentId(startMs: number | null, endMs: number | null, text: string): string {
  const hash = createHash("sha1").update(JSON.stringify([startMs, endMs, text])).digest("hex").slice(0, 16);
  return `mistral:${hash}`;
}

function extractError(payload: any): ErrorRaisedPayload {
  const message =
    payload?.error?.message?.detail ||
    payload?.error?.message ||
    payload?.error?.detail ||
    "Mistral realtime transcription error";
  return {
    code: payload?.error?.type || "transcription_error",
    message: typeof message === "string" ? message : JSON.stringify(message),
    fatal: false,
    details: typeof payload?.error === "object" ? payload.error : { payload },
  };
}

export class MistralRealtimeTranscriptionAdapter implements TranscriptionAdapter {
  private readonly provider: TranscriptionProvider = "mistral";
  private readonly callbacks: TranscriptionAdapterCallbacks;
  private readonly providerRawPath: string;
  private readonly segmentsPath: string;
  private readonly meetingRunId: string;
  private readonly roomId: string;
  private readonly apiKey: string;

  private ws: WebSocket | null = null;
  private wsOpen = false;
  private connected = false;
  private stopped = false;
  private sessionStarted = false;
  private sessionStopped = false;
  private providerSessionId: string | null = null;
  private sampleRateHz = 16_000;
  private pcmStreamStartedAtUnixMs: number | null = null;
  private outboundAudioQueue: string[] = [];
  private partialSegmentId = uuidv7();
  private partialText = "";
  private seenFinalSegmentIds = new Set<string>();
  private lastFinalText = "";
  private openPromise: Promise<void> | null = null;
  private donePromise: Promise<void> | null = null;
  private doneResolve: (() => void) | null = null;
  private lastFlushAtUnixMs = 0;
  private inboundMessageQueue = Promise.resolve();

  constructor(options: MistralAdapterOptions) {
    this.apiKey = options.apiKey;
    this.meetingRunId = options.meetingRunId;
    this.roomId = options.roomId;
    this.providerRawPath = options.providerRawPath;
    this.segmentsPath = options.segmentsPath;
    this.callbacks = options.callbacks;
  }

  private resetSessionState(): void {
    this.sessionStarted = false;
    this.sessionStopped = false;
    this.providerSessionId = null;
    this.partialSegmentId = uuidv7();
    this.partialText = "";
    this.lastFinalText = "";
    this.ws = null;
    this.wsOpen = false;
    this.connected = false;
    this.openPromise = null;
    this.donePromise = null;
    this.doneResolve = null;
  }

  async start(payload: AudioCaptureStartedPayload): Promise<void> {
    if (this.connected || this.openPromise) {
      return;
    }

    this.resetSessionState();
    this.sampleRateHz = payload.pcm_sample_rate_hz;
    this.donePromise = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });

    const model = getRealtimeModel();
    const wsUrl = `${getRealtimeWsUrl()}?model=${encodeURIComponent(model)}`;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      } as any);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.wsOpen = true;
        void this.sendJson({
          type: "session.update",
          session: {
            audio_format: {
              encoding: "pcm_s16le",
              sample_rate: payload.pcm_sample_rate_hz,
            },
            target_streaming_delay_ms: getStreamingDelayMs(),
          },
        });
        void this.flushQueuedAudio();
        resolve();
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const rawText = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        this.inboundMessageQueue = this.inboundMessageQueue
          .then(() => this.handleMessage(rawText))
          .catch(async (error) => {
            await this.callbacks.raiseError({
              code: "mistral_message_handler_failed",
              message: error instanceof Error ? error.message : String(error),
              fatal: false,
            });
          });
      });

      ws.addEventListener("error", () => {
        const errorPayload: ErrorRaisedPayload = {
          code: "mistral_socket_error",
          message: "Mistral realtime websocket error",
          fatal: false,
        };
        void this.callbacks.raiseError(errorPayload);
        reject(new Error(errorPayload.message));
      });

      ws.addEventListener("close", () => {
        this.wsOpen = false;
        this.connected = false;
        this.ws = null;
        this.openPromise = null;
        if (!this.sessionStopped) {
          void this.emitSessionStopped("socket_closed");
        }
        this.doneResolve?.();
      });
    });

    try {
      await this.openPromise;
      this.openPromise = null;
      this.connected = true;
      await this.callbacks.log(`mistral realtime connected model=${model}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.callbacks.raiseError({
        code: "mistral_connect_failed",
        message,
        fatal: false,
      });
      this.openPromise = null;
    }
  }

  async pushFrame(frame: RealtimeAudioFrame): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.pcmStreamStartedAtUnixMs === null) {
      this.pcmStreamStartedAtUnixMs = frame.ts_unix_ms;
    }

    const encoded = Buffer.from(frame.payload).toString("base64");
    if (this.wsOpen && this.ws) {
      this.ws.send(JSON.stringify({ type: "input_audio.append", audio: encoded }));
    } else {
      this.outboundAudioQueue.push(encoded);
    }

    if (frame.ts_unix_ms - this.lastFlushAtUnixMs >= 1_000) {
      this.lastFlushAtUnixMs = frame.ts_unix_ms;
      await this.flushAudio();
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    this.stopped = true;
    await this.flushAudio();
    await this.sendJson({ type: "input_audio.end" });

    if (this.donePromise) {
      await Promise.race([this.donePromise, sleep(2_000)]);
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close();
    }
    await this.emitSessionStopped(reason);
  }

  private async flushQueuedAudio(): Promise<void> {
    if (!this.wsOpen || !this.ws || this.outboundAudioQueue.length === 0) {
      return;
    }
    const queued = [...this.outboundAudioQueue];
    this.outboundAudioQueue = [];
    for (const audio of queued) {
      this.ws.send(JSON.stringify({ type: "input_audio.append", audio }));
    }
  }

  private async sendJson(payload: unknown): Promise<void> {
    if (!this.wsOpen || !this.ws) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private async flushAudio(): Promise<void> {
    await this.sendJson({ type: "input_audio.flush" });
  }

  private absoluteUnixMs(relativeSeconds: number | null | undefined): number | null {
    if (relativeSeconds === null || relativeSeconds === undefined || this.pcmStreamStartedAtUnixMs === null) {
      return null;
    }
    return this.pcmStreamStartedAtUnixMs + Math.round(relativeSeconds * 1000);
  }

  private async handleMessage(rawText: string): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      await this.callbacks.raiseError({
        code: "mistral_invalid_json",
        message: `Invalid JSON from Mistral: ${String(error)}`,
        fatal: false,
      });
      return;
    }

    await appendJsonLine(this.providerRawPath, {
      received_at_unix_ms: nowUnixMs(),
      payload,
    });
    await this.callbacks.appendProviderRaw(payload);

    switch (payload.type) {
      case "session.created":
      case "session.updated":
        await this.handleSessionEvent(payload);
        break;
      case "transcription.language":
        break;
      case "transcription.text.delta":
        await this.handleTextDelta(payload);
        break;
      case "transcription.segment":
        await this.handleFinalSegment(payload);
        break;
      case "transcription.done":
        await this.handleDone(payload);
        break;
      case "error":
        await this.callbacks.raiseError(extractError(payload));
        break;
      default:
        await this.callbacks.log(`unhandled mistral message type=${payload.type ?? "unknown"}`);
        break;
    }
  }

  private async handleSessionEvent(payload: { session?: MistralSessionState }): Promise<void> {
    this.providerSessionId = payload.session?.request_id ?? this.providerSessionId;
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      await this.callbacks.emitEvent(
        "transcription",
        "transcription.session.started",
        buildSessionStartedPayload(this.provider, this.providerSessionId, this.sampleRateHz),
        payload,
      );
    }
  }

  private async handleTextDelta(payload: { text?: string }): Promise<void> {
    const delta = typeof payload.text === "string" ? payload.text : "";
    if (!delta) {
      return;
    }
    this.partialText += delta;
    const emittedAtUnixMs = nowUnixMs();
    const segmentPayload: TranscriptionSegmentPayload = {
      speech_segment_id: this.partialSegmentId,
      provider: this.provider,
      provider_segment_id: null,
      text: this.partialText,
      status: "partial",
      started_at_unix_ms: this.pcmStreamStartedAtUnixMs,
      ended_at_unix_ms: null,
      speaker_label: null,
      speaker_confidence: null,
    };
    await appendJsonLine(this.segmentsPath, buildSegmentRecord(this.meetingRunId, this.roomId, segmentPayload, emittedAtUnixMs));
    await this.callbacks.appendSegment(segmentPayload);
    await this.callbacks.emitEvent("transcription", "transcription.segment.partial", segmentPayload, payload, emittedAtUnixMs);
  }

  private async handleFinalSegment(payload: { text?: string; start?: number; end?: number; speaker_id?: string | null }): Promise<void> {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const startAtUnixMs = this.absoluteUnixMs(typeof payload.start === "number" ? payload.start : null);
    const endAtUnixMs = this.absoluteUnixMs(typeof payload.end === "number" ? payload.end : null);
    const speechSegmentId = buildSegmentId(startAtUnixMs, endAtUnixMs, text);
    if (this.seenFinalSegmentIds.has(speechSegmentId)) {
      return;
    }
    this.seenFinalSegmentIds.add(speechSegmentId);
    this.lastFinalText = text;
    this.partialText = "";
    this.partialSegmentId = uuidv7();

    const emittedAtUnixMs = nowUnixMs();
    const segmentPayload: TranscriptionSegmentPayload = {
      speech_segment_id: speechSegmentId,
      provider: this.provider,
      provider_segment_id: speechSegmentId,
      text,
      status: "final",
      started_at_unix_ms: startAtUnixMs,
      ended_at_unix_ms: endAtUnixMs,
      speaker_label: typeof payload.speaker_id === "string" ? payload.speaker_id : null,
      speaker_confidence: null,
    };
    await appendJsonLine(this.segmentsPath, buildSegmentRecord(this.meetingRunId, this.roomId, segmentPayload, emittedAtUnixMs));
    await this.callbacks.appendSegment(segmentPayload);
    await this.callbacks.emitEvent("transcription", "transcription.segment.final", segmentPayload, payload, emittedAtUnixMs);
  }

  private async handleDone(payload: {
    text?: string;
    segments?: Array<{ text?: string; start?: number; end?: number; speaker_id?: string | null; score?: number | null }>;
  }): Promise<void> {
    const segments = payload.segments ?? [];
    for (const segment of segments) {
      await this.handleFinalSegment(segment);
    }
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (segments.length === 0 && text && text !== this.lastFinalText) {
      await this.handleFinalSegment({
        text,
        start: undefined,
        end: undefined,
        speaker_id: null,
      });
    }
  }

  private async emitSessionStopped(reason: string, raw?: unknown): Promise<void> {
    if (this.sessionStopped) {
      return;
    }
    this.sessionStopped = true;
    await this.callbacks.emitEvent(
      "transcription",
      "transcription.session.stopped",
      {
        provider: this.provider,
        provider_session_id: this.providerSessionId,
        reason,
      },
      raw,
      nowUnixMs(),
    );
  }
}
