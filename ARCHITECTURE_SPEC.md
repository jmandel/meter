# Zoom Meeting Capture Architecture Spec

## Status

Target-state specification for the system this repository should evolve into.

This document intentionally describes the desired design, APIs, storage layout,
and TypeScript contracts without inheriting limitations from the current spike.

## Goals

1. Capture one or more Zoom meetings concurrently.
2. Isolate each meeting in its own short-lived worker runtime.
3. Persist everything durably:
   - append-only event journal
   - normalized queryable SQLite index
   - compressed meeting audio on disk
   - logs and diagnostics
4. Expose a stable REST API for query and control.
5. Expose SSE streams for live event delivery and replay after reconnect.
6. Support a single-process deployment for simplicity and a split-process
   deployment for isolation.

## Non-Goals

1. Real-time browser rendering or human-facing UI design.
2. Multi-host distributed coordination.
3. Perfect speaker diarization from day one.
4. Tight coupling to a single transcription provider.

## Core Decisions

1. The system runs as one codebase with multiple modes:
   - `all`
   - `api`
   - `worker`
2. The public API is long-lived and centralized.
3. Each meeting is handled by a dedicated short-lived worker.
4. Meeting scope is a lifecycle boundary, not the primary query boundary.
5. Durable storage uses both:
   - per-meeting files for raw archival artifacts
   - one central SQLite database for query and indexing
6. Audio is captured in two forms:
   - compressed archival audio for durable replay
   - low-latency PCM frames for live transcription
7. Raw events are retained even when normalized projections exist.

## Glossary

- `room_id`: stable identity for a recurring Zoom room or meeting URL. In most
  cases this is derived from the normalized Zoom meeting ID.
- `meeting_run_id`: one concrete capture attempt for one meeting occurrence.
- `worker_id`: identity of a worker process handling one meeting run.
- `event_id`: global monotonically increasing integer assigned by SQLite.
- `seq`: worker-local monotonically increasing event sequence number.
- `artifact`: any durable file written for a meeting, including logs and audio.

## Runtime Architecture

### Components

1. `Coordinator/API`
   - long-lived process
   - owns central SQLite
   - exposes public REST and SSE
   - starts and stops workers
   - indexes and queries all meeting runs

2. `Meeting Worker`
   - short-lived process
   - handles one `meeting_run_id`
   - launches dedicated Chromium
   - joins the Zoom web client
   - hosts loopback ingest endpoints for the injected browser code
   - writes per-meeting files
   - forwards normalized events to the coordinator

3. `Injected Browser Runtime`
   - runs inside the Zoom tab
   - captures compressed archival audio
   - captures PCM frames for transcription
   - emits DOM-derived events such as speaker changes and chat messages
   - sends data only to the owning worker over loopback

4. `Transcription Adapter`
   - provider-neutral module
   - receives PCM frames
   - emits partial and final speech events
   - stores raw provider messages as events

5. `Projection Engine`
   - subscribes to appended events
   - updates normalized SQLite tables
   - drives search, aggregates, and live SSE fanout

### Deployment Modes

#### Mode: `all`

Single Bun process containing coordinator and worker supervisor. Best for local
usage and the initial product.

#### Mode: `api`

Long-lived coordinator only. It accepts control requests and spawns `worker`
subprocesses.

#### Mode: `worker`

One worker only. Used when started by the coordinator or for direct debugging.

## Process Model

### Coordinator Responsibilities

1. Allocate `meeting_run_id`.
2. Normalize the Zoom URL into a `room_id`.
3. Create meeting folder structure.
4. Allocate ephemeral loopback ports and one-time auth tokens for the worker.
5. Spawn a worker subprocess when running split mode.
6. Accept event batches, heartbeats, state changes, and completion reports.
7. Append all accepted events into SQLite `event_log`.
8. Update normalized tables.
9. Serve REST and SSE.

### Worker Responsibilities

1. Launch Chromium with an isolated profile directory.
2. Join the Zoom web client.
3. Inject capture/bootstrap code into the meeting page.
4. Host a private loopback ingest server for the page:
   - control websocket
   - PCM websocket channel
   - compressed audio upload endpoint
5. Persist per-meeting artifacts locally before acknowledging success.
6. Stream normalized events to the coordinator.
7. Exit cleanly when the meeting ends, capture fails, or a stop command is
   received.

## Identifier and Naming Rules

1. `meeting_run_id` uses UUIDv7.
2. `worker_id` uses UUIDv7.
3. `room_id` format is `zoom:<normalized_meeting_id>`.
4. `event_id` is an auto-increment integer in SQLite.
5. All timestamps are stored as:
   - `ts_unix_ms` integer
   - `ts_iso` ISO 8601 UTC string when exposed over the API

## Durability Model

### Source of Truth

The durable source of truth is the combination of:

1. per-meeting append-only raw journal on disk
2. central SQLite event log

If normalized tables disagree with raw events, raw events win and projections
must be replayable.

### Write Order

For every event produced by a worker:

1. append event to the meeting's `events.ndjson`
2. durably write any referenced artifact, if applicable
3. forward the event to the coordinator
4. append event to SQLite `event_log`
5. update projections
6. fan out to SSE subscribers

### Audio Durability

Archival audio is written as compressed WebM/Opus chunks to disk even if the
transcription provider is unavailable. Transcription never owns the only copy of
captured audio.

## File Layout

```text
data/
  index.sqlite
  index.sqlite-shm
  index.sqlite-wal
  coordinator/
    coordinator.log
    state/
      workers.json
  meetings/
    2026/
      2026-03-11/
        mtg_01HV3XJQBG6J7N6W8F7R6V4D5E/
          metadata.json
          lifecycle.json
          events.ndjson
          worker.log
          browser.log
          errors.ndjson
          artifacts/
            dom/
              000001.html
            screenshots/
              000001.png
          audio/
            archive/
              manifest.json
              000001.webm
              000002.webm
            live/
              pcm_manifest.json
              000001.pcm
              000002.pcm
          transcripts/
            provider_raw.ndjson
            segments.jsonl
```

### File Semantics

1. `metadata.json`
   - immutable meeting run metadata
   - identifiers, URLs, config snapshot

2. `lifecycle.json`
   - current worker state
   - mutable, last-write-wins convenience file

3. `events.ndjson`
   - append-only raw event journal
   - one JSON object per line

4. `errors.ndjson`
   - append-only error objects for easy triage

5. `audio/archive/*.webm`
   - compressed archival audio chunks
   - default codec: `audio/webm;codecs=opus`

6. `audio/live/*.pcm`
   - optional raw PCM chunks used for debugging or replay
   - may be disabled in production

7. `transcripts/provider_raw.ndjson`
   - raw upstream transcription messages

8. `transcripts/segments.jsonl`
   - derived speech segment records emitted by the transcription adapter

## SQLite Schema

SQLite is the primary query engine. It must run in WAL mode and enable FTS5.

### Tables

#### `meeting_runs`

One row per meeting run.

#### `rooms`

One row per stable Zoom room identity.

#### `event_log`

Append-only canonical event log across all meeting runs.

#### `speech_segments`

Normalized speech segments. Includes partial and final states.

#### `chat_messages`

Normalized chat records.

#### `speaker_spans`

Intervals during which the UI indicated an active speaker.

#### `audio_objects`

Rows for archived audio chunks and audio manifests.

#### `artifacts`

Rows for non-audio files such as screenshots and DOM captures.

#### `worker_heartbeats`

Latest worker heartbeat information.

### FTS Tables

1. `speech_segments_fts`
2. `chat_messages_fts`

### Recommended Columns

The exact SQL can evolve, but the logical columns below are part of the spec.

```ts
export interface MeetingRunRow {
  meeting_run_id: string;
  room_id: string;
  source: "zoom";
  normalized_join_url: string;
  requested_by: string | null;
  bot_name: string;
  state:
    | "pending"
    | "starting"
    | "joining"
    | "capturing"
    | "stopping"
    | "completed"
    | "failed"
    | "aborted";
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  worker_id: string | null;
  worker_pid: number | null;
  ingest_port: number | null;
  cdp_port: number | null;
  data_dir: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface RoomRow {
  room_id: string;
  provider: "zoom";
  provider_room_key: string;
  display_name: string | null;
  normalized_join_url: string;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface EventLogRow {
  event_id: number;
  meeting_run_id: string;
  room_id: string;
  seq: number;
  source: EventSourceKind;
  kind: EventKind;
  ts_unix_ms: number;
  ingest_unix_ms: number;
  payload_json: string;
  raw_json: string | null;
}

export interface SpeechSegmentRow {
  speech_segment_id: string;
  meeting_run_id: string;
  room_id: string;
  event_id: number;
  provider: TranscriptionProvider;
  provider_segment_id: string | null;
  text: string;
  normalized_text: string;
  status: "partial" | "final";
  speaker_label: string | null;
  speaker_confidence: number | null;
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  emitted_at_unix_ms: number;
}

export interface ChatMessageRow {
  chat_message_id: string;
  meeting_run_id: string;
  room_id: string;
  event_id: number;
  sender_display_name: string | null;
  receiver_display_name: string | null;
  visibility: "everyone" | "direct" | "panel_unknown";
  text: string;
  normalized_text: string;
  sent_at_unix_ms: number;
}

export interface SpeakerSpanRow {
  speaker_span_id: string;
  meeting_run_id: string;
  room_id: string;
  started_at_unix_ms: number;
  ended_at_unix_ms: number | null;
  speaker_display_name: string | null;
  source_event_id_start: number;
  source_event_id_end: number | null;
}

export interface AudioObjectRow {
  audio_object_id: string;
  meeting_run_id: string;
  room_id: string;
  stream_kind: "archive" | "live_pcm";
  content_type: string;
  codec: string | null;
  path: string;
  byte_length: number;
  chunk_seq: number;
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  sha256_hex: string | null;
  created_at_unix_ms: number;
}
```

## Event Model

### Event Envelope

All worker-produced events use the same envelope.

```ts
export type EventSourceKind =
  | "system"
  | "worker"
  | "browser"
  | "zoom_dom"
  | "audio_capture"
  | "transcription";

export type EventKind =
  | "system.meeting_run.created"
  | "system.worker.started"
  | "system.worker.heartbeat"
  | "system.worker.completed"
  | "system.worker.failed"
  | "browser.console"
  | "browser.page.loaded"
  | "browser.capture.bootstrap_ready"
  | "zoom.chat.message"
  | "zoom.speaker.active"
  | "zoom.meeting.joined"
  | "zoom.meeting.left"
  | "audio.archive.chunk_written"
  | "audio.live_pcm.chunk_written"
  | "audio.capture.started"
  | "audio.capture.stopped"
  | "transcription.session.started"
  | "transcription.segment.partial"
  | "transcription.segment.final"
  | "transcription.session.stopped"
  | "artifact.written"
  | "error.raised";

export interface EventEnvelope<TPayload = unknown> {
  meeting_run_id: string;
  room_id: string;
  seq: number;
  source: EventSourceKind;
  kind: EventKind;
  ts_unix_ms: number;
  payload: TPayload;
  raw?: unknown;
}
```

### Payload Types

```ts
export interface WorkerStartedPayload {
  worker_id: string;
  pid: number;
  ingest_port: number;
  cdp_port: number;
  chrome_user_data_dir: string;
}

export interface WorkerHeartbeatPayload {
  worker_id: string;
  state: MeetingRunState;
  cpu_pct?: number;
  rss_bytes?: number;
  open_ws_connections?: number;
}

export interface BrowserConsolePayload {
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

export interface ZoomMeetingJoinedPayload {
  title: string | null;
  page_url: string;
  joined_at_unix_ms: number;
}

export interface ZoomSpeakerActivePayload {
  speaker_display_name: string | null;
}

export interface ZoomChatMessagePayload {
  chat_message_id: string;
  sender_display_name: string | null;
  receiver_display_name: string | null;
  visibility: "everyone" | "direct" | "panel_unknown";
  text: string;
  sent_at_unix_ms: number;
}

export interface AudioCaptureStartedPayload {
  archive_stream_id: string;
  live_stream_id: string;
  archive_content_type: string;
  archive_codec: string | null;
  pcm_sample_rate_hz: number;
  pcm_channels: number;
}

export interface AudioArchiveChunkWrittenPayload {
  audio_object_id: string;
  archive_stream_id: string;
  path: string;
  chunk_seq: number;
  byte_length: number;
  content_type: string;
  codec: string | null;
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  sha256_hex: string | null;
}

export interface TranscriptionSessionStartedPayload {
  provider: TranscriptionProvider;
  provider_session_id: string | null;
  sample_rate_hz: number;
}

export interface TranscriptionSegmentPayload {
  speech_segment_id: string;
  provider: TranscriptionProvider;
  provider_segment_id: string | null;
  text: string;
  status: "partial" | "final";
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  speaker_label: string | null;
  speaker_confidence: number | null;
}

export interface ArtifactWrittenPayload {
  artifact_id: string;
  kind: "dom_snapshot" | "screenshot" | "log" | "other";
  path: string;
  content_type: string | null;
  byte_length: number | null;
}

export interface ErrorRaisedPayload {
  code: string;
  message: string;
  fatal: boolean;
  details?: Record<string, unknown>;
}
```

## TypeScript Domain Interfaces

```ts
export type MeetingRunState =
  | "pending"
  | "starting"
  | "joining"
  | "capturing"
  | "stopping"
  | "completed"
  | "failed"
  | "aborted";

export type TranscriptionProvider =
  | "mistral"
  | "openai"
  | "none"
  | "custom";

export interface AppConfig {
  mode: "all" | "api" | "worker";
  public_base_url: string;
  listen_host: string;
  listen_port: number;
  data_root: string;
  chrome_bin: string;
  default_bot_name: string;
  transcription_provider: TranscriptionProvider;
  persist_live_pcm: boolean;
  persist_archive_audio: boolean;
  archive_chunk_ms: number;
  live_pcm_chunk_ms: number;
  sqlite_path: string;
}

export interface CreateMeetingRunRequest {
  join_url: string;
  bot_name?: string;
  requested_by?: string | null;
  tags?: string[];
  options?: Partial<MeetingRunOptions>;
}

export interface MeetingRunOptions {
  open_chat_panel: boolean;
  enable_transcription: boolean;
  enable_speaker_tracking: boolean;
  enable_chat_tracking: boolean;
  persist_archive_audio: boolean;
  persist_live_pcm: boolean;
  archive_chunk_ms: number;
  live_pcm_chunk_ms: number;
  auto_stop_when_meeting_ends: boolean;
}

export interface MeetingRunRecord {
  meeting_run_id: string;
  room_id: string;
  source: "zoom";
  normalized_join_url: string;
  bot_name: string;
  requested_by: string | null;
  tags: string[];
  state: MeetingRunState;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  worker: WorkerSummary | null;
  paths: MeetingRunPaths;
  options: MeetingRunOptions;
  stats: MeetingRunStats;
  last_error: ApiErrorBody | null;
}

export interface WorkerSummary {
  worker_id: string;
  pid: number | null;
  ingest_port: number | null;
  cdp_port: number | null;
  status: "online" | "offline";
  last_heartbeat_at: string | null;
}

export interface MeetingRunPaths {
  data_dir: string;
  event_journal_path: string;
  archive_audio_dir: string;
  live_pcm_dir: string | null;
  worker_log_path: string;
  browser_log_path: string;
}

export interface MeetingRunStats {
  event_count: number;
  speech_segment_count: number;
  chat_message_count: number;
  audio_object_count: number;
  archive_audio_bytes: number;
}

export interface EventRecord<TPayload = unknown> {
  event_id: number;
  meeting_run_id: string;
  room_id: string;
  seq: number;
  source: EventSourceKind;
  kind: EventKind;
  ts: string;
  payload: TPayload;
  raw?: unknown;
}

export interface SpeechSegmentRecord {
  speech_segment_id: string;
  event_id: number;
  meeting_run_id: string;
  room_id: string;
  provider: TranscriptionProvider;
  provider_segment_id: string | null;
  text: string;
  status: "partial" | "final";
  speaker_label: string | null;
  speaker_confidence: number | null;
  started_at: string | null;
  ended_at: string | null;
  emitted_at: string;
}

export interface ChatMessageRecord {
  chat_message_id: string;
  event_id: number;
  meeting_run_id: string;
  room_id: string;
  sender_display_name: string | null;
  receiver_display_name: string | null;
  visibility: "everyone" | "direct" | "panel_unknown";
  text: string;
  sent_at: string;
}

export interface SpeakerSpanRecord {
  speaker_span_id: string;
  meeting_run_id: string;
  room_id: string;
  speaker_display_name: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AudioObjectRecord {
  audio_object_id: string;
  meeting_run_id: string;
  room_id: string;
  stream_kind: "archive" | "live_pcm";
  content_type: string;
  codec: string | null;
  chunk_seq: number;
  byte_length: number;
  sha256_hex: string | null;
  started_at: string | null;
  ended_at: string | null;
  download_url: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

export interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
}
```

## Public REST API

All public APIs are versioned under `/v1`.

### Health

#### `GET /v1/health`

Returns process and storage health.

```ts
export interface HealthResponse {
  ok: true;
  now: string;
  mode: "all" | "api";
  sqlite: {
    path: string;
    wal_mode: boolean;
    writable: boolean;
  };
  workers: {
    active_count: number;
  };
}
```

### Meeting Run Control

#### `POST /v1/meeting-runs`

Create and start a meeting run.

Request body:

```ts
export type PostMeetingRunsBody = CreateMeetingRunRequest;
```

Response:

```ts
export interface PostMeetingRunsResponse {
  meeting_run: MeetingRunRecord;
}
```

#### `GET /v1/meeting-runs`

List meeting runs.

Query parameters:

- `state`
- `room_id`
- `from`
- `to`
- `cursor`
- `limit`

Response:

```ts
export type GetMeetingRunsResponse = ListResponse<MeetingRunRecord>;
```

#### `GET /v1/meeting-runs/:meeting_run_id`

Get one meeting run.

Response:

```ts
export interface GetMeetingRunResponse {
  meeting_run: MeetingRunRecord;
}
```

#### `POST /v1/meeting-runs/:meeting_run_id/stop`

Request a graceful stop.

Request body:

```ts
export interface StopMeetingRunRequest {
  reason?: string;
}
```

Response:

```ts
export interface StopMeetingRunResponse {
  meeting_run_id: string;
  accepted: true;
}
```

### Events

#### `GET /v1/events`

Global event query across all meeting runs.

Query parameters:

- `meeting_run_id`
- `room_id`
- `source`
- `kind`
- `from`
- `to`
- `after_event_id`
- `cursor`
- `limit`

Response:

```ts
export type GetEventsResponse = ListResponse<EventRecord>;
```

#### `GET /v1/meeting-runs/:meeting_run_id/events`

Meeting-scoped event query.

Response:

```ts
export type GetMeetingRunEventsResponse = ListResponse<EventRecord>;
```

### Speech

#### `GET /v1/speech`

Cross-meeting speech query.

Query parameters:

- `meeting_run_id`
- `room_id`
- `speaker_label`
- `status`
- `q`
- `from`
- `to`
- `cursor`
- `limit`

Response:

```ts
export type GetSpeechResponse = ListResponse<SpeechSegmentRecord>;
```

#### `GET /v1/meeting-runs/:meeting_run_id/speech`

Meeting-scoped speech query.

Response:

```ts
export type GetMeetingRunSpeechResponse = ListResponse<SpeechSegmentRecord>;
```

### Chat

#### `GET /v1/chat`

Cross-meeting chat query.

Query parameters:

- `meeting_run_id`
- `room_id`
- `sender_display_name`
- `receiver_display_name`
- `q`
- `from`
- `to`
- `cursor`
- `limit`

Response:

```ts
export type GetChatResponse = ListResponse<ChatMessageRecord>;
```

#### `GET /v1/meeting-runs/:meeting_run_id/chat`

Meeting-scoped chat query.

Response:

```ts
export type GetMeetingRunChatResponse = ListResponse<ChatMessageRecord>;
```

### Speaker Spans

#### `GET /v1/meeting-runs/:meeting_run_id/speakers`

Response:

```ts
export type GetSpeakerSpansResponse = ListResponse<SpeakerSpanRecord>;
```

### Rooms

#### `GET /v1/rooms`

List rooms.

```ts
export interface RoomRecord {
  room_id: string;
  provider: "zoom";
  provider_room_key: string;
  display_name: string | null;
  normalized_join_url: string;
  created_at: string;
  updated_at: string;
}

export type GetRoomsResponse = ListResponse<RoomRecord>;
```

#### `GET /v1/rooms/:room_id/meeting-runs`

Response:

```ts
export type GetRoomMeetingRunsResponse = ListResponse<MeetingRunRecord>;
```

### Search

#### `GET /v1/search`

Unified search across final speech and chat text.

Query parameters:

- `q` required
- `meeting_run_id`
- `room_id`
- `from`
- `to`
- `cursor`
- `limit`

Response:

```ts
export interface SearchHit {
  hit_kind: "speech" | "chat";
  meeting_run_id: string;
  room_id: string;
  event_id: number;
  text: string;
  snippet: string;
  ts: string;
}

export type SearchResponse = ListResponse<SearchHit>;
```

### Audio

#### `GET /v1/meeting-runs/:meeting_run_id/audio`

Lists archived audio objects and manifests.

```ts
export type GetMeetingRunAudioResponse = ListResponse<AudioObjectRecord>;
```

#### `GET /v1/audio-objects/:audio_object_id`

Returns metadata for one audio object.

```ts
export interface GetAudioObjectResponse {
  audio_object: AudioObjectRecord;
}
```

#### `GET /v1/audio-objects/:audio_object_id/content`

Streams the underlying audio file. Supports byte ranges.

### Artifacts

#### `GET /v1/meeting-runs/:meeting_run_id/artifacts`

Lists non-audio artifacts.

```ts
export interface ArtifactRecord {
  artifact_id: string;
  meeting_run_id: string;
  room_id: string;
  kind: "dom_snapshot" | "screenshot" | "log" | "other";
  path: string;
  content_type: string | null;
  byte_length: number | null;
  created_at: string;
  download_url: string;
}

export type GetArtifactsResponse = ListResponse<ArtifactRecord>;
```

#### `GET /v1/artifacts/:artifact_id/content`

Streams the artifact file.

## SSE API

All SSE endpoints emit `id`, `event`, and `data`.

### Event ID Rules

1. SSE `id` is the SQLite `event_id`.
2. Reconnect uses `Last-Event-ID`.
3. `after_event_id` query parameter is also supported.

### `GET /v1/stream`

Global live stream.

Filters via query parameters:

- `meeting_run_id`
- `room_id`
- `kind`
- `source`
- `after_event_id`

Event names:

- `event`
- `heartbeat`

Payload:

```ts
export interface SseEventFrame {
  event_id: number;
  event: EventRecord;
}
```

### `GET /v1/meeting-runs/:meeting_run_id/stream`

Meeting-scoped live stream.

### `GET /v1/rooms/:room_id/stream`

Room-scoped live stream across meeting runs.

## Worker/Coordinator Internal API

This API is private and bound to loopback or protected by a shared secret.

All internal endpoints are versioned under `/internal/v1`.

### Worker Registration

#### `POST /internal/v1/workers/register`

```ts
export interface WorkerRegisterRequest {
  worker_id: string;
  meeting_run_id: string;
  pid: number;
  ingest_port: number;
  cdp_port: number;
  started_at_unix_ms: number;
}

export interface WorkerRegisterResponse {
  accepted: true;
}
```

### Worker Heartbeat

#### `POST /internal/v1/workers/:worker_id/heartbeat`

```ts
export interface WorkerHeartbeatRequest {
  meeting_run_id: string;
  state: MeetingRunState;
  ts_unix_ms: number;
  cpu_pct?: number;
  rss_bytes?: number;
}

export interface WorkerHeartbeatResponse {
  accepted: true;
  stop_requested: boolean;
}
```

### Event Batch Append

#### `POST /internal/v1/meeting-runs/:meeting_run_id/events:batch`

```ts
export interface AppendEventsBatchRequest {
  worker_id: string;
  first_seq: number;
  last_seq: number;
  events: EventEnvelope[];
}

export interface AppendEventsBatchResponse {
  accepted: true;
  highest_event_id: number;
}
```

### Worker Completion

#### `POST /internal/v1/meeting-runs/:meeting_run_id/complete`

```ts
export interface CompleteMeetingRunRequest {
  worker_id: string;
  final_state: "completed" | "failed" | "aborted";
  ended_at_unix_ms: number;
  error?: ErrorRaisedPayload;
}

export interface CompleteMeetingRunResponse {
  accepted: true;
}
```

## Browser-to-Worker Ingest API

This API is private to the injected browser runtime and only bound to loopback.

Every request includes a one-time `browser_token`.

### Capture Bootstrap Asset

#### `GET /internal/browser/bootstrap.js?token=...`

Returns the injected runtime script used by the worker. This allows the worker
to serve versioned capture code without embedding a giant inline string in the
CDP layer.

### Control and PCM Stream

#### `GET /internal/browser/session?token=...`

WebSocket upgrade endpoint.

The websocket carries:

1. JSON control messages
2. binary PCM frames

#### JSON Messages

```ts
export type BrowserControlMessage =
  | BrowserHelloMessage
  | BrowserDomEventMessage
  | BrowserCaptureStartedMessage
  | BrowserCaptureStoppedMessage
  | BrowserUploadAckRequest;

export interface BrowserHelloMessage {
  type: "hello";
  page_url: string;
  user_agent: string;
  ts_unix_ms: number;
}

export interface BrowserCaptureStartedMessage {
  type: "capture.started";
  archive_stream_id: string;
  live_stream_id: string;
  archive_content_type: string;
  archive_codec: string | null;
  pcm_sample_rate_hz: number;
  pcm_channels: number;
  ts_unix_ms: number;
}

export interface BrowserCaptureStoppedMessage {
  type: "capture.stopped";
  reason: "ended" | "manual" | "error";
  ts_unix_ms: number;
}

export interface BrowserDomEventMessage {
  type: "dom.event";
  event: EventEnvelope<unknown>;
}

export interface BrowserUploadAckRequest {
  type: "archive.flush";
  archive_stream_id: string;
  highest_chunk_seq: number;
  ts_unix_ms: number;
}
```

#### Binary PCM Frame Format

Every binary frame on the websocket is a PCM packet with a fixed 24-byte
header followed by signed 16-bit little-endian mono PCM payload.

Header layout:

```ts
export interface PcmFrameHeader {
  magic: "ZPCM"; // 4 bytes ASCII
  version: 1; // uint16
  reserved: 0; // uint16
  stream_seq: number; // uint32
  ts_unix_ms: number; // uint64
  sample_rate_hz: number; // uint32
  payload_bytes: number; // uint32
}
```

### Compressed Audio Upload

#### `POST /internal/browser/archive/:archive_stream_id/:chunk_seq?token=...`

Request body:

- raw `audio/webm;codecs=opus` bytes

Required headers:

- `Content-Type`
- `X-Chunk-Started-At`
- `X-Chunk-Ended-At`
- `X-Sha256`

Response:

```ts
export interface ArchiveChunkUploadResponse {
  accepted: true;
  audio_object_id: string;
  path: string;
  byte_length: number;
}
```

## Audio Capture Spec

### Archival Audio

1. Browser runtime starts `MediaRecorder` from the captured meeting audio track.
2. Mime type target: `audio/webm;codecs=opus`.
3. Default chunk duration: 5000 ms.
4. Each chunk is uploaded immediately to the worker and written to
   `audio/archive/<chunk_seq>.webm`.
5. Each successful write emits `audio.archive.chunk_written`.

### Live Transcription Audio

1. Browser runtime also feeds the same captured audio into an `AudioWorklet`.
2. Audio is resampled to 16 kHz mono PCM S16LE unless the provider config says
   otherwise.
3. Default live chunk duration: 480 ms.
4. Each PCM frame is sent over the websocket to the worker.
5. The worker forwards frames to the transcription adapter.
6. Optionally, live PCM frames are also written to `audio/live/*.pcm`.

### Audio Manifest

Every meeting with archival audio has `audio/archive/manifest.json`.

```ts
export interface AudioArchiveManifest {
  archive_stream_id: string;
  meeting_run_id: string;
  room_id: string;
  content_type: string;
  codec: string | null;
  chunk_count: number;
  total_bytes: number;
  started_at: string | null;
  ended_at: string | null;
  chunks: Array<{
    audio_object_id: string;
    chunk_seq: number;
    path: string;
    byte_length: number;
    started_at: string | null;
    ended_at: string | null;
    sha256_hex: string | null;
  }>;
}
```

## Transcription Spec

The transcription layer is provider-neutral and emits raw and normalized data.

### Required Behavior

1. The adapter persists raw provider messages.
2. The adapter emits `transcription.session.started`.
3. The adapter emits zero or more `transcription.segment.partial`.
4. The adapter emits final `transcription.segment.final`.
5. Final segments are upserted into `speech_segments`.
6. Partial segments may be retained for debugging and live UI, but queries
   default to final segments unless requested otherwise.

### Speaker Attribution

Speaker attribution for transcript segments is computed by joining segment time
windows to `speaker_spans`.

Fields:

1. `speaker_label`
2. `speaker_confidence`

Speaker attribution remains best-effort and can be recomputed later by replaying
events.

## Lifecycle

### Create Flow

1. Client calls `POST /v1/meeting-runs`.
2. Coordinator normalizes the Zoom URL.
3. Coordinator creates `meeting_run_id`, folder structure, and metadata.
4. Coordinator starts a worker.
5. Worker registers itself.
6. Worker launches Chromium and joins the meeting.
7. Worker injects bootstrap code.
8. Browser runtime starts archival audio and live PCM.
9. Worker emits `audio.capture.started`.
10. Worker enters `capturing` state.

### Steady-State Flow

1. Browser sends DOM events and audio.
2. Worker persists local artifacts and events.
3. Worker batches events to the coordinator.
4. Coordinator appends to SQLite and updates projections.
5. Coordinator emits SSE updates.

### Stop Flow

1. Client requests stop or worker detects meeting end.
2. Worker stops browser capture.
3. Worker flushes pending archival chunks and manifests.
4. Worker closes transcription session.
5. Worker sends completion report.
6. Coordinator marks the run final.

## Error Model

All public API errors use:

```ts
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

Suggested public error codes:

- `invalid_request`
- `meeting_run_not_found`
- `room_not_found`
- `worker_unavailable`
- `storage_error`
- `capture_start_failed`
- `transcription_error`
- `artifact_not_found`
- `conflict`

## Security Model

1. Public API may bind to any configured host.
2. Internal coordinator endpoints bind to loopback by default.
3. Worker browser ingest endpoints bind to loopback only.
4. Worker uses a coordinator auth token.
5. Browser runtime uses a one-time browser token.
6. Artifact download endpoints must validate path ownership through metadata,
   not by trusting client-provided paths.

## Pagination and Ordering

1. All list endpoints are cursor-based.
2. Default ordering is ascending by natural event time or `event_id`.
3. `cursor` is an opaque token, not an offset.
4. Event APIs also support `after_event_id` for SSE replay semantics.

## Module Layout

The desired source layout is:

```text
src/
  cli/
    main.ts
  config/
    env.ts
    defaults.ts
  coordinator/
    api-server.ts
    worker-supervisor.ts
    projections.ts
    sse-broker.ts
  worker/
    meeting-worker.ts
    chrome-session.ts
    zoom-join-flow.ts
    browser-ingest-server.ts
    capture-bootstrap.ts
  ingestion/
    event-sink.ts
    sqlite-event-log.ts
    journal-writer.ts
    artifact-store.ts
  transcription/
    adapter.ts
    mistral-adapter.ts
    segment-normalizer.ts
  api/
    routes/
      health.ts
      meeting-runs.ts
      events.ts
      speech.ts
      chat.ts
      rooms.ts
      audio.ts
      artifacts.ts
      stream.ts
  types/
    api.ts
    domain.ts
    events.ts
  utils/
    ids.ts
    time.ts
    zoom-url.ts
```

## Implementation Notes

1. Use SQLite WAL mode.
2. Use prepared statements for all hot paths.
3. Use append-only journaling for raw events.
4. Batch worker event uploads.
5. Keep raw audio and normalized transcript independent.
6. Make projections replayable from `events.ndjson` and `event_log`.

## Recommended Defaults

```ts
export const DEFAULTS = {
  archive_chunk_ms: 5000,
  live_pcm_chunk_ms: 480,
  persist_archive_audio: true,
  persist_live_pcm: false,
  transcription_provider: "mistral" as const,
  open_chat_panel: true,
  enable_transcription: true,
  enable_speaker_tracking: true,
  enable_chat_tracking: true,
  auto_stop_when_meeting_ends: true,
};
```

## Acceptance Criteria

The system satisfies this spec when:

1. Two concurrent meeting runs can execute without port or profile collisions.
2. Each meeting run has a complete folder with metadata, event journal, logs,
   and compressed audio artifacts.
3. All chat and speech events are queryable through REST.
4. Live updates are available through SSE with replay after reconnect.
5. Workers can fail independently without taking down the public API.
6. Projections can be rebuilt from raw stored events.
