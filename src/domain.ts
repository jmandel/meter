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
  | "zoom.store.snapshot"
  | "zoom.attendee.joined"
  | "zoom.attendee.left"
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

export interface InternalConfig extends AppConfig {
  coordinator_base_url: string;
  coordinator_token: string;
  heartbeat_interval_ms: number;
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

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
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
  sender_user_id?: number | null;
  receiver_display_name: string | null;
  receiver_user_id?: number | null;
  visibility: "everyone" | "direct" | "panel_unknown";
  text: string;
  sent_at: string;
  main_chat_message_id?: string | null;
  thread_reply_count?: number | null;
  is_thread_reply?: boolean;
  is_edited?: boolean;
  chat_type?: string | null;
  details?: Record<string, unknown> | null;
}

export interface SpeakerSpanRecord {
  speaker_span_id: string;
  meeting_run_id: string;
  room_id: string;
  speaker_display_name: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AttendeeSummaryRecord {
  attendee_key: string;
  meeting_run_id: string;
  room_id: string;
  display_name: string | null;
  aliases: string[];
  attendee_ids: string[];
  user_ids: number[];
  is_host: boolean;
  is_co_host: boolean;
  is_guest: boolean;
  present: boolean;
  join_count: number;
  leave_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
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

export interface RoomRecord {
  room_id: string;
  provider: "zoom";
  provider_room_key: string;
  display_name: string | null;
  normalized_join_url: string;
  created_at: string;
  updated_at: string;
}

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

export interface SearchHit {
  hit_kind: "speech" | "chat";
  meeting_run_id: string;
  room_id: string;
  event_id: number;
  text: string;
  snippet: string;
  ts: string;
}

export interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
}

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

export interface ZoomStoreSnapshotPayload {
  captured_at_unix_ms: number;
  capture_strategy: "redux_store";
  top_level_keys: string[];
  attendee_count: number | null;
  chat_message_count: number | null;
}

export interface ZoomAttendeePresencePayload {
  attendee_id: string;
  user_id: number | null;
  display_name: string | null;
  is_host: boolean;
  is_co_host: boolean;
  is_guest: boolean;
  muted: boolean | null;
  video_on: boolean | null;
  audio_connection: string | null;
  last_spoken_at_unix_ms: number | null;
  backfilled: boolean;
  details?: Record<string, unknown> | null;
}

export interface ZoomChatMessagePayload {
  chat_message_id: string;
  sender_display_name: string | null;
  sender_user_id?: number | null;
  receiver_display_name: string | null;
  receiver_user_id?: number | null;
  visibility: "everyone" | "direct" | "panel_unknown";
  text: string;
  sent_at_unix_ms: number;
  main_chat_message_id?: string | null;
  thread_reply_count?: number | null;
  is_thread_reply?: boolean;
  is_edited?: boolean;
  chat_type?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AudioCaptureStartedPayload {
  archive_stream_id: string;
  live_stream_id: string;
  archive_content_type: string;
  archive_codec: string | null;
  pcm_sample_rate_hz: number;
  pcm_channels: number;
}

export interface AudioChunkWrittenPayload {
  audio_object_id: string;
  stream_kind: "archive" | "live_pcm";
  stream_id: string;
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

export interface WorkerHeartbeatRequest {
  meeting_run_id: string;
  state: MeetingRunState;
  ts_unix_ms: number;
  cpu_pct?: number;
  rss_bytes?: number;
  open_ws_connections?: number;
}

export interface WorkerHeartbeatResponse {
  accepted: true;
  stop_requested: boolean;
}

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

export interface CompleteMeetingRunRequest {
  worker_id: string;
  final_state: "completed" | "failed" | "aborted";
  ended_at_unix_ms: number;
  error?: ErrorRaisedPayload;
}

export interface CompleteMeetingRunResponse {
  accepted: true;
}

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
  raw?: unknown;
}

export type BrowserControlMessage =
  | BrowserHelloMessage
  | BrowserCaptureStartedMessage
  | BrowserCaptureStoppedMessage
  | BrowserDomEventMessage;

export interface PcmFrameHeader {
  magic: "ZPCM";
  version: 1;
  reserved: 0;
  stream_seq: number;
  ts_unix_ms: number;
  sample_rate_hz: number;
  payload_bytes: number;
}

export interface WorkerLaunchConfig {
  app: InternalConfig;
  meeting_run_id: string;
  room_id: string;
  normalized_join_url: string;
  bot_name: string;
  requested_by: string | null;
  tags: string[];
  options: MeetingRunOptions;
  paths: MeetingRunPaths;
  browser_token: string;
}

export interface MeetingMetadataFile {
  meeting_run_id: string;
  room_id: string;
  normalized_join_url: string;
  requested_by: string | null;
  bot_name: string;
  created_at_unix_ms: number;
  tags: string[];
  options: MeetingRunOptions;
}

export interface MeetingLifecycleFile {
  meeting_run_id: string;
  state: MeetingRunState;
  worker_id: string | null;
  worker_pid: number | null;
  ingest_port: number | null;
  cdp_port: number | null;
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  updated_at_unix_ms: number;
  last_error: ApiErrorBody | null;
}
