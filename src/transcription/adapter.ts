import type {
  AudioCaptureStartedPayload,
  ErrorRaisedPayload,
  EventKind,
  EventSourceKind,
  TranscriptionSegmentPayload,
  TranscriptionSessionStartedPayload,
  TranscriptionProvider,
} from "../domain";

export interface RealtimeAudioFrame {
  stream_seq: number;
  ts_unix_ms: number;
  sample_rate_hz: number;
  payload: Uint8Array;
}

export interface TranscriptionAdapterCallbacks {
  emitEvent(
    source: EventSourceKind,
    kind: EventKind,
    payload: unknown,
    raw?: unknown,
    tsUnixMs?: number,
  ): Promise<void>;
  appendProviderRaw(entry: unknown): Promise<void>;
  appendSegment(entry: unknown): Promise<void>;
  raiseError(error: ErrorRaisedPayload): Promise<void>;
  log(message: string): Promise<void>;
}

export interface TranscriptionAdapterContext {
  provider: TranscriptionProvider;
  callbacks: TranscriptionAdapterCallbacks;
}

export interface TranscriptionAdapter {
  start(payload: AudioCaptureStartedPayload): Promise<void>;
  pushFrame(frame: RealtimeAudioFrame): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export class NoopTranscriptionAdapter implements TranscriptionAdapter {
  async start(_payload: AudioCaptureStartedPayload): Promise<void> {}

  async pushFrame(_frame: RealtimeAudioFrame): Promise<void> {}

  async stop(_reason = "stopped"): Promise<void> {}
}

export function buildSessionStartedPayload(
  provider: TranscriptionProvider,
  providerSessionId: string | null,
  sampleRateHz: number,
): TranscriptionSessionStartedPayload {
  return {
    provider,
    provider_session_id: providerSessionId,
    sample_rate_hz: sampleRateHz,
  };
}

export function buildSegmentRecord(
  meetingRunId: string,
  roomId: string,
  payload: TranscriptionSegmentPayload,
  emittedAtUnixMs: number,
) {
  return {
    meeting_run_id: meetingRunId,
    room_id: roomId,
    ...payload,
    emitted_at_unix_ms: emittedAtUnixMs,
  };
}
