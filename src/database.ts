import { Database } from "bun:sqlite";

import type {
  AppConfig,
  ArtifactRecord,
  ArtifactWrittenPayload,
  AudioChunkWrittenPayload,
  AudioObjectRecord,
  ChatMessageRecord,
  ErrorRaisedPayload,
  EventEnvelope,
  EventRecord,
  MinuteClaudeEffort,
  MinuteJobRecord,
  MinuteJobState,
  MinuteVersionRecord,
  MeetingRunOptions,
  MeetingRunPaths,
  MeetingRunRecord,
  MeetingRunState,
  RoomRecord,
  SearchHit,
  SpeakerSpanRecord,
  SpeechSegmentRecord,
  TranscriptionSegmentPayload,
  WorkerHeartbeatRequest,
  WorkerSummary,
  ZoomChatMessagePayload,
  ZoomSpeakerActivePayload,
} from "./domain";
import { normalizeText, toIso, uuidv7 } from "./utils";

interface RoomInsertInput {
  room_id: string;
  provider_room_key: string;
  normalized_join_url: string;
  display_name: string | null;
  now_unix_ms: number;
}

interface MeetingRunInsertInput {
  meeting_run_id: string;
  room_id: string;
  normalized_join_url: string;
  requested_by: string | null;
  bot_name: string;
  state: MeetingRunState;
  created_at_unix_ms: number;
  data_dir: string;
  tags: string[];
  options: MeetingRunOptions;
  paths: MeetingRunPaths;
}

interface MeetingRunPatch {
  state?: MeetingRunState;
  started_at_unix_ms?: number | null;
  ended_at_unix_ms?: number | null;
  worker_id?: string | null;
  worker_pid?: number | null;
  ingest_port?: number | null;
  cdp_port?: number | null;
  updated_at_unix_ms?: number;
  last_error_code?: string | null;
  last_error_message?: string | null;
}

interface MeetingRunRow {
  meeting_run_id: string;
  room_id: string;
  source: "zoom";
  normalized_join_url: string;
  requested_by: string | null;
  bot_name: string;
  state: MeetingRunState;
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
  tags_json: string;
  options_json: string;
  paths_json: string;
  heartbeat_ts_unix_ms: number | null;
}

interface MinuteJobInsertInput {
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  state: MinuteJobState;
  tmux_session_name: string | null;
  command: string | null;
  prompt_label: string | null;
  prompt_hash: string | null;
  user_prompt_body: string | null;
  user_final_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: MinuteClaudeEffort | null;
  working_dir: string;
  latest_minutes_path: string;
  started_at_unix_ms: number;
  restarted_from_minute_job_id: string | null;
}

interface MinuteJobPatch {
  state?: MinuteJobState;
  tmux_session_name?: string | null;
  command?: string | null;
  prompt_label?: string | null;
  prompt_hash?: string | null;
  user_prompt_body?: string | null;
  user_final_prompt_body?: string | null;
  claude_model?: string | null;
  claude_effort?: MinuteClaudeEffort | null;
  latest_content_sha256?: string | null;
  latest_version_seq?: number;
  ended_at_unix_ms?: number | null;
  last_update_at_unix_ms?: number | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
}

interface MinuteJobRow {
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  state: MinuteJobState;
  tmux_session_name: string | null;
  command: string | null;
  prompt_label: string | null;
  prompt_hash: string | null;
  user_prompt_body: string | null;
  user_final_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: MinuteClaudeEffort | null;
  working_dir: string;
  latest_minutes_path: string;
  latest_content_sha256: string | null;
  latest_version_seq: number;
  started_at_unix_ms: number;
  ended_at_unix_ms: number | null;
  last_update_at_unix_ms: number | null;
  restarted_from_minute_job_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface MinuteVersionInsertInput {
  minute_version_id: string;
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  seq: number;
  status: "live" | "final";
  content_markdown: string;
  content_sha256: string;
  created_at_unix_ms: number;
}

interface MinuteVersionRow {
  minute_version_id: string;
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  seq: number;
  status: "live" | "final";
  content_markdown: string;
  content_sha256: string;
  created_at_unix_ms: number;
}

export class AppDatabase {
  readonly db: Database;

  constructor(private readonly config: AppConfig) {
    this.db = new Database(config.sqlite_path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_room_key TEXT NOT NULL UNIQUE,
        display_name TEXT,
        normalized_join_url TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_runs (
        meeting_run_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(room_id),
        source TEXT NOT NULL,
        normalized_join_url TEXT NOT NULL,
        requested_by TEXT,
        bot_name TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at_unix_ms INTEGER,
        ended_at_unix_ms INTEGER,
        worker_id TEXT,
        worker_pid INTEGER,
        ingest_port INTEGER,
        cdp_port INTEGER,
        data_dir TEXT NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at_unix_ms INTEGER NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        paths_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_runs_room_id ON meeting_runs(room_id);
      CREATE INDEX IF NOT EXISTS idx_meeting_runs_state ON meeting_runs(state);
      CREATE INDEX IF NOT EXISTS idx_meeting_runs_created_at ON meeting_runs(created_at_unix_ms DESC);

      CREATE TABLE IF NOT EXISTS event_log (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_run_id TEXT NOT NULL REFERENCES meeting_runs(meeting_run_id),
        room_id TEXT NOT NULL REFERENCES rooms(room_id),
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        ts_unix_ms INTEGER NOT NULL,
        ingest_unix_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        raw_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_meeting_seq ON event_log(meeting_run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_event_log_meeting_event ON event_log(meeting_run_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_event_log_room_event ON event_log(room_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_event_log_kind ON event_log(kind, event_id);
      CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source, event_id);

      CREATE TABLE IF NOT EXISTS speech_segments (
        speech_segment_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_segment_id TEXT,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        status TEXT NOT NULL,
        speaker_label TEXT,
        speaker_confidence REAL,
        started_at_unix_ms INTEGER,
        ended_at_unix_ms INTEGER,
        emitted_at_unix_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_speech_segments_meeting_event ON speech_segments(meeting_run_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_speech_segments_room_event ON speech_segments(room_id, event_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        chat_message_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        sender_display_name TEXT,
        receiver_display_name TEXT,
        visibility TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        sent_at_unix_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_meeting_event ON chat_messages(meeting_run_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_room_event ON chat_messages(room_id, event_id);

      CREATE TABLE IF NOT EXISTS speaker_spans (
        speaker_span_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        started_at_unix_ms INTEGER NOT NULL,
        ended_at_unix_ms INTEGER,
        speaker_display_name TEXT,
        source_event_id_start INTEGER NOT NULL,
        source_event_id_end INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_speaker_spans_meeting_start ON speaker_spans(meeting_run_id, started_at_unix_ms);

      CREATE TABLE IF NOT EXISTS audio_objects (
        audio_object_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        stream_kind TEXT NOT NULL,
        content_type TEXT NOT NULL,
        codec TEXT,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        chunk_seq INTEGER NOT NULL,
        started_at_unix_ms INTEGER,
        ended_at_unix_ms INTEGER,
        sha256_hex TEXT,
        created_at_unix_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audio_objects_meeting_chunk ON audio_objects(meeting_run_id, chunk_seq);

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT,
        byte_length INTEGER,
        created_at_unix_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_meeting_created ON artifacts(meeting_run_id, created_at_unix_ms DESC);

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        ts_unix_ms INTEGER NOT NULL,
        cpu_pct REAL,
        rss_bytes INTEGER,
        open_ws_connections INTEGER,
        updated_at_unix_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS minute_jobs (
        minute_job_id TEXT PRIMARY KEY,
        meeting_run_id TEXT NOT NULL REFERENCES meeting_runs(meeting_run_id),
        room_id TEXT NOT NULL REFERENCES rooms(room_id),
        state TEXT NOT NULL,
        tmux_session_name TEXT,
        command TEXT,
        prompt_label TEXT,
        prompt_hash TEXT,
        user_prompt_body TEXT,
        user_final_prompt_body TEXT,
        claude_model TEXT,
        claude_effort TEXT,
        working_dir TEXT NOT NULL,
        latest_minutes_path TEXT NOT NULL,
        latest_content_sha256 TEXT,
        latest_version_seq INTEGER NOT NULL DEFAULT 0,
        started_at_unix_ms INTEGER NOT NULL,
        ended_at_unix_ms INTEGER,
        last_update_at_unix_ms INTEGER,
        restarted_from_minute_job_id TEXT,
        last_error_code TEXT,
        last_error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_minute_jobs_meeting_run_started ON minute_jobs(meeting_run_id, started_at_unix_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_minute_jobs_state ON minute_jobs(state);

      CREATE TABLE IF NOT EXISTS minute_versions (
        minute_version_id TEXT PRIMARY KEY,
        minute_job_id TEXT NOT NULL REFERENCES minute_jobs(minute_job_id),
        meeting_run_id TEXT NOT NULL REFERENCES meeting_runs(meeting_run_id),
        room_id TEXT NOT NULL REFERENCES rooms(room_id),
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_minute_versions_job_seq ON minute_versions(minute_job_id, seq);
      CREATE INDEX IF NOT EXISTS idx_minute_versions_meeting_created ON minute_versions(meeting_run_id, created_at_unix_ms DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS speech_segments_fts USING fts5(
        speech_segment_id UNINDEXED,
        meeting_run_id UNINDEXED,
        room_id UNINDEXED,
        text
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        chat_message_id UNINDEXED,
        meeting_run_id UNINDEXED,
        room_id UNINDEXED,
        text
      );
    `);

    this.ensureColumn("chat_messages", "sender_user_id", "INTEGER");
    this.ensureColumn("chat_messages", "receiver_user_id", "INTEGER");
    this.ensureColumn("chat_messages", "main_chat_message_id", "TEXT");
    this.ensureColumn("chat_messages", "thread_reply_count", "INTEGER");
    this.ensureColumn("chat_messages", "is_thread_reply", "INTEGER");
    this.ensureColumn("chat_messages", "is_edited", "INTEGER");
    this.ensureColumn("chat_messages", "chat_type", "TEXT");
    this.ensureColumn("chat_messages", "details_json", "TEXT");
    this.ensureColumn("minute_jobs", "claude_model", "TEXT");
    this.ensureColumn("minute_jobs", "claude_effort", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_main_chat_message_id ON chat_messages(main_chat_message_id);");
  }

  close(): void {
    this.db.close();
  }

  getJournalMode(): string {
    const row = this.db.query("PRAGMA journal_mode;").get() as { journal_mode: string } | null;
    return row?.journal_mode ?? "unknown";
  }

  private ensureColumn(tableName: string, columnName: string, columnSql: string): void {
    const columns = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql};`);
  }

  upsertRoom(input: RoomInsertInput): void {
    this.db
      .query(`
        INSERT INTO rooms (
          room_id,
          provider,
          provider_room_key,
          display_name,
          normalized_join_url,
          created_at_unix_ms,
          updated_at_unix_ms
        ) VALUES (?, 'zoom', ?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          provider_room_key = excluded.provider_room_key,
          display_name = COALESCE(excluded.display_name, rooms.display_name),
          normalized_join_url = excluded.normalized_join_url,
          updated_at_unix_ms = excluded.updated_at_unix_ms
      `)
      .run(
        input.room_id,
        input.provider_room_key,
        input.display_name,
        input.normalized_join_url,
        input.now_unix_ms,
        input.now_unix_ms,
      );
  }

  insertMeetingRun(input: MeetingRunInsertInput): void {
    this.db
      .query(`
        INSERT INTO meeting_runs (
          meeting_run_id,
          room_id,
          source,
          normalized_join_url,
          requested_by,
          bot_name,
          state,
          started_at_unix_ms,
          ended_at_unix_ms,
          worker_id,
          worker_pid,
          ingest_port,
          cdp_port,
          data_dir,
          last_error_code,
          last_error_message,
          created_at_unix_ms,
          updated_at_unix_ms,
          tags_json,
          options_json,
          paths_json
        ) VALUES (?, ?, 'zoom', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?)
      `)
      .run(
        input.meeting_run_id,
        input.room_id,
        input.normalized_join_url,
        input.requested_by,
        input.bot_name,
        input.state,
        input.data_dir,
        input.created_at_unix_ms,
        input.created_at_unix_ms,
        JSON.stringify(input.tags),
        JSON.stringify(input.options),
        JSON.stringify(input.paths),
      );
  }

  patchMeetingRun(meetingRunId: string, patch: MeetingRunPatch): void {
    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [column, value] of Object.entries(patch)) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }

    if (assignments.length === 0) {
      return;
    }

    values.push(meetingRunId);
    this.db.query(`UPDATE meeting_runs SET ${assignments.join(", ")} WHERE meeting_run_id = ?`).run(...values);
  }

  getMeetingRunRow(meetingRunId: string): MeetingRunRow | null {
    return (this.db
      .query(`
        SELECT
          mr.*,
          wh.ts_unix_ms AS heartbeat_ts_unix_ms
        FROM meeting_runs mr
        LEFT JOIN worker_heartbeats wh
          ON wh.worker_id = mr.worker_id
        WHERE mr.meeting_run_id = ?
      `)
      .get(meetingRunId) as MeetingRunRow | null) ?? null;
  }

  listMeetingRunRows(filters: {
    state?: string | null;
    room_id?: string | null;
    from?: number | null;
    to?: number | null;
    limit: number;
  }): MeetingRunRow[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.state) {
      where.push("mr.state = ?");
      values.push(filters.state);
    }
    if (filters.room_id) {
      where.push("mr.room_id = ?");
      values.push(filters.room_id);
    }
    if (filters.from !== null && filters.from !== undefined) {
      where.push("mr.created_at_unix_ms >= ?");
      values.push(filters.from);
    }
    if (filters.to !== null && filters.to !== undefined) {
      where.push("mr.created_at_unix_ms <= ?");
      values.push(filters.to);
    }
    values.push(filters.limit);
    return this.db
      .query(`
        SELECT
          mr.*,
          wh.ts_unix_ms AS heartbeat_ts_unix_ms
        FROM meeting_runs mr
        LEFT JOIN worker_heartbeats wh
          ON wh.worker_id = mr.worker_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY mr.created_at_unix_ms DESC
        LIMIT ?
      `)
      .all(...values) as MeetingRunRow[];
  }

  recordWorkerHeartbeat(workerId: string, input: WorkerHeartbeatRequest, nowUnixMs: number): void {
    this.db
      .query(`
        INSERT INTO worker_heartbeats (
          worker_id,
          meeting_run_id,
          state,
          ts_unix_ms,
          cpu_pct,
          rss_bytes,
          open_ws_connections,
          updated_at_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          meeting_run_id = excluded.meeting_run_id,
          state = excluded.state,
          ts_unix_ms = excluded.ts_unix_ms,
          cpu_pct = excluded.cpu_pct,
          rss_bytes = excluded.rss_bytes,
          open_ws_connections = excluded.open_ws_connections,
          updated_at_unix_ms = excluded.updated_at_unix_ms
      `)
      .run(
        workerId,
        input.meeting_run_id,
        input.state,
        input.ts_unix_ms,
        input.cpu_pct ?? null,
        input.rss_bytes ?? null,
        input.open_ws_connections ?? null,
        nowUnixMs,
      );
  }

  appendEvents(events: EventEnvelope[], ingestUnixMs: number): { highest_event_id: number; records: EventRecord[] } {
    this.db.exec("BEGIN IMMEDIATE;");
    const records: EventRecord[] = [];
    let highestEventId = 0;

    try {
      for (const event of events) {
        const result = this.db
          .query(`
            INSERT INTO event_log (
              meeting_run_id,
              room_id,
              seq,
              source,
              kind,
              ts_unix_ms,
              ingest_unix_ms,
              payload_json,
              raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            event.meeting_run_id,
            event.room_id,
            event.seq,
            event.source,
            event.kind,
            event.ts_unix_ms,
            ingestUnixMs,
            JSON.stringify(event.payload ?? null),
            event.raw === undefined ? null : JSON.stringify(event.raw),
          );
        const eventId = Number(result.lastInsertRowid);
        highestEventId = eventId;
        this.applyEventProjection(eventId, event);
        records.push({
          event_id: eventId,
          meeting_run_id: event.meeting_run_id,
          room_id: event.room_id,
          seq: event.seq,
          source: event.source,
          kind: event.kind,
          ts: new Date(event.ts_unix_ms).toISOString(),
          payload: event.payload,
          raw: event.raw,
        });
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return {
      highest_event_id: highestEventId,
      records,
    };
  }

  reserveCoordinatorSeq(meetingRunId: string): number {
    const row = this.db
      .query(`
        SELECT COALESCE(MIN(seq), 0) - 1 AS value
        FROM event_log
        WHERE meeting_run_id = ?
      `)
      .get(meetingRunId) as { value: number };
    return Number(row.value);
  }

  private applyEventProjection(eventId: number, event: EventEnvelope): void {
    switch (event.kind) {
      case "transcription.segment.partial":
      case "transcription.segment.final":
        this.projectSpeechSegment(eventId, event);
        break;
      case "zoom.chat.message":
        this.projectChatMessage(eventId, event);
        break;
      case "zoom.speaker.active":
        this.projectSpeakerSpan(eventId, event);
        break;
      case "audio.archive.chunk_written":
      case "audio.live_pcm.chunk_written":
        this.projectAudioObject(event);
        break;
      case "artifact.written":
        this.projectArtifact(event);
        break;
      case "zoom.meeting.left":
      case "system.worker.completed":
      case "system.worker.failed":
        this.closeOpenSpeakerSpan(event.meeting_run_id, eventId, event.ts_unix_ms);
        break;
      default:
        break;
    }
  }

  private projectSpeechSegment(eventId: number, event: EventEnvelope): void {
    const payload = event.payload as TranscriptionSegmentPayload;
    this.db
      .query(`
        INSERT INTO speech_segments (
          speech_segment_id,
          meeting_run_id,
          room_id,
          event_id,
          provider,
          provider_segment_id,
          text,
          normalized_text,
          status,
          speaker_label,
          speaker_confidence,
          started_at_unix_ms,
          ended_at_unix_ms,
          emitted_at_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(speech_segment_id) DO UPDATE SET
          event_id = excluded.event_id,
          provider = excluded.provider,
          provider_segment_id = excluded.provider_segment_id,
          text = excluded.text,
          normalized_text = excluded.normalized_text,
          status = excluded.status,
          speaker_label = excluded.speaker_label,
          speaker_confidence = excluded.speaker_confidence,
          started_at_unix_ms = excluded.started_at_unix_ms,
          ended_at_unix_ms = excluded.ended_at_unix_ms,
          emitted_at_unix_ms = excluded.emitted_at_unix_ms
      `)
      .run(
        payload.speech_segment_id,
        event.meeting_run_id,
        event.room_id,
        eventId,
        payload.provider,
        payload.provider_segment_id,
        payload.text,
        normalizeText(payload.text),
        payload.status,
        payload.speaker_label,
        payload.speaker_confidence ?? null,
        payload.started_at_unix_ms ?? null,
        payload.ended_at_unix_ms ?? null,
        event.ts_unix_ms,
      );
    this.db.query("DELETE FROM speech_segments_fts WHERE speech_segment_id = ?").run(payload.speech_segment_id);
    this.db
      .query("INSERT INTO speech_segments_fts (speech_segment_id, meeting_run_id, room_id, text) VALUES (?, ?, ?, ?)")
      .run(payload.speech_segment_id, event.meeting_run_id, event.room_id, payload.text);
  }

  private projectChatMessage(eventId: number, event: EventEnvelope): void {
    const payload = event.payload as ZoomChatMessagePayload;
    this.db
      .query(`
        INSERT INTO chat_messages (
          chat_message_id,
          meeting_run_id,
          room_id,
          event_id,
          sender_display_name,
          sender_user_id,
          receiver_display_name,
          receiver_user_id,
          visibility,
          text,
          normalized_text,
          sent_at_unix_ms,
          main_chat_message_id,
          thread_reply_count,
          is_thread_reply,
          is_edited,
          chat_type,
          details_json
        ) VALUES (
          $chat_message_id,
          $meeting_run_id,
          $room_id,
          $event_id,
          $sender_display_name,
          $sender_user_id,
          $receiver_display_name,
          $receiver_user_id,
          $visibility,
          $text,
          $normalized_text,
          $sent_at_unix_ms,
          $main_chat_message_id,
          $thread_reply_count,
          $is_thread_reply,
          $is_edited,
          $chat_type,
          $details_json
        )
        ON CONFLICT(chat_message_id) DO UPDATE SET
          event_id = excluded.event_id,
          sender_display_name = excluded.sender_display_name,
          sender_user_id = excluded.sender_user_id,
          receiver_display_name = excluded.receiver_display_name,
          receiver_user_id = excluded.receiver_user_id,
          visibility = excluded.visibility,
          text = excluded.text,
          normalized_text = excluded.normalized_text,
          sent_at_unix_ms = excluded.sent_at_unix_ms,
          main_chat_message_id = excluded.main_chat_message_id,
          thread_reply_count = excluded.thread_reply_count,
          is_thread_reply = excluded.is_thread_reply,
          is_edited = excluded.is_edited,
          chat_type = excluded.chat_type,
          details_json = excluded.details_json
      `)
      .run({
        $chat_message_id: payload.chat_message_id,
        $meeting_run_id: event.meeting_run_id,
        $room_id: event.room_id,
        $event_id: eventId,
        $sender_display_name: payload.sender_display_name,
        $sender_user_id: payload.sender_user_id ?? null,
        $receiver_display_name: payload.receiver_display_name,
        $receiver_user_id: payload.receiver_user_id ?? null,
        $visibility: payload.visibility,
        $text: payload.text,
        $normalized_text: normalizeText(payload.text),
        $sent_at_unix_ms: payload.sent_at_unix_ms,
        $main_chat_message_id: payload.main_chat_message_id ?? null,
        $thread_reply_count: payload.thread_reply_count ?? null,
        $is_thread_reply: payload.is_thread_reply ? 1 : 0,
        $is_edited: payload.is_edited ? 1 : 0,
        $chat_type: payload.chat_type ?? null,
        $details_json: payload.details ? JSON.stringify(payload.details) : null,
      });
    this.db.query("DELETE FROM chat_messages_fts WHERE chat_message_id = ?").run(payload.chat_message_id);
    this.db
      .query("INSERT INTO chat_messages_fts (chat_message_id, meeting_run_id, room_id, text) VALUES (?, ?, ?, ?)")
      .run(payload.chat_message_id, event.meeting_run_id, event.room_id, payload.text);
  }

  private projectSpeakerSpan(eventId: number, event: EventEnvelope): void {
    const payload = event.payload as ZoomSpeakerActivePayload;
    const existing = this.db
      .query(`
        SELECT speaker_span_id, speaker_display_name
        FROM speaker_spans
        WHERE meeting_run_id = ? AND ended_at_unix_ms IS NULL
        ORDER BY started_at_unix_ms DESC
        LIMIT 1
      `)
      .get(event.meeting_run_id) as { speaker_span_id: string; speaker_display_name: string | null } | null;
    if (existing && existing.speaker_display_name === (payload.speaker_display_name ?? null)) {
      return;
    }
    if (existing) {
      this.db
        .query(`
          UPDATE speaker_spans
          SET ended_at_unix_ms = ?, source_event_id_end = ?
          WHERE speaker_span_id = ?
        `)
        .run(event.ts_unix_ms, eventId, existing.speaker_span_id);
    }
    this.db
      .query(`
        INSERT INTO speaker_spans (
          speaker_span_id,
          meeting_run_id,
          room_id,
          started_at_unix_ms,
          ended_at_unix_ms,
          speaker_display_name,
          source_event_id_start,
          source_event_id_end
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
      `)
      .run(uuidv7(event.ts_unix_ms), event.meeting_run_id, event.room_id, event.ts_unix_ms, payload.speaker_display_name ?? null, eventId);
  }

  private closeOpenSpeakerSpan(meetingRunId: string, eventId: number, tsUnixMs: number): void {
    this.db
      .query(`
        UPDATE speaker_spans
        SET ended_at_unix_ms = ?, source_event_id_end = ?
        WHERE meeting_run_id = ? AND ended_at_unix_ms IS NULL
      `)
      .run(tsUnixMs, eventId, meetingRunId);
  }

  private projectAudioObject(event: EventEnvelope): void {
    const payload = event.payload as AudioChunkWrittenPayload;
    this.db
      .query(`
        INSERT INTO audio_objects (
          audio_object_id,
          meeting_run_id,
          room_id,
          stream_kind,
          content_type,
          codec,
          path,
          byte_length,
          chunk_seq,
          started_at_unix_ms,
          ended_at_unix_ms,
          sha256_hex,
          created_at_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(audio_object_id) DO UPDATE SET
          content_type = excluded.content_type,
          codec = excluded.codec,
          path = excluded.path,
          byte_length = excluded.byte_length,
          chunk_seq = excluded.chunk_seq,
          started_at_unix_ms = excluded.started_at_unix_ms,
          ended_at_unix_ms = excluded.ended_at_unix_ms,
          sha256_hex = excluded.sha256_hex
      `)
      .run(
        payload.audio_object_id,
        event.meeting_run_id,
        event.room_id,
        payload.stream_kind,
        payload.content_type,
        payload.codec,
        payload.path,
        payload.byte_length,
        payload.chunk_seq,
        payload.started_at_unix_ms ?? null,
        payload.ended_at_unix_ms ?? null,
        payload.sha256_hex ?? null,
        event.ts_unix_ms,
      );
  }

  private projectArtifact(event: EventEnvelope): void {
    const payload = event.payload as ArtifactWrittenPayload;
    this.db
      .query(`
        INSERT INTO artifacts (
          artifact_id,
          meeting_run_id,
          room_id,
          kind,
          path,
          content_type,
          byte_length,
          created_at_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          kind = excluded.kind,
          path = excluded.path,
          content_type = excluded.content_type,
          byte_length = excluded.byte_length
      `)
      .run(
        payload.artifact_id,
        event.meeting_run_id,
        event.room_id,
        payload.kind,
        payload.path,
        payload.content_type ?? null,
        payload.byte_length ?? null,
        event.ts_unix_ms,
      );
  }

  private computeStats(meetingRunId: string): MeetingRunRecord["stats"] {
    const eventCount = this.db.query("SELECT COUNT(*) AS value FROM event_log WHERE meeting_run_id = ?").get(meetingRunId) as { value: number };
    const speechCount = this.db.query("SELECT COUNT(*) AS value FROM speech_segments WHERE meeting_run_id = ?").get(meetingRunId) as { value: number };
    const chatCount = this.db.query("SELECT COUNT(*) AS value FROM chat_messages WHERE meeting_run_id = ?").get(meetingRunId) as { value: number };
    const audioCount = this.db.query("SELECT COUNT(*) AS value FROM audio_objects WHERE meeting_run_id = ?").get(meetingRunId) as { value: number };
    const audioBytes = this.db
      .query(`
        SELECT COALESCE(SUM(byte_length), 0) AS value
        FROM audio_objects
        WHERE meeting_run_id = ? AND stream_kind = 'archive'
      `)
      .get(meetingRunId) as { value: number };
    return {
      event_count: Number(eventCount.value ?? 0),
      speech_segment_count: Number(speechCount.value ?? 0),
      chat_message_count: Number(chatCount.value ?? 0),
      audio_object_count: Number(audioCount.value ?? 0),
      archive_audio_bytes: Number(audioBytes.value ?? 0),
    };
  }

  private buildWorkerSummary(row: MeetingRunRow): WorkerSummary | null {
    if (!row.worker_id) {
      return null;
    }
    return {
      worker_id: row.worker_id,
      pid: row.worker_pid,
      ingest_port: row.ingest_port,
      cdp_port: row.cdp_port,
      status:
        row.state === "completed" || row.state === "failed" || row.state === "aborted"
          ? "offline"
          : row.heartbeat_ts_unix_ms && row.heartbeat_ts_unix_ms > Date.now() - 30_000
            ? "online"
            : "offline",
      last_heartbeat_at: toIso(row.heartbeat_ts_unix_ms),
    };
  }

  private mapMinuteJobRow(row: MinuteJobRow): MinuteJobRecord {
    return {
      minute_job_id: row.minute_job_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      state: row.state,
      tmux_session_name: row.tmux_session_name,
      command: row.command,
      prompt_label: row.prompt_label,
      prompt_hash: row.prompt_hash,
      user_prompt_body: row.user_prompt_body,
      user_final_prompt_body: row.user_final_prompt_body,
      claude_model: row.claude_model,
      claude_effort: row.claude_effort,
      working_dir: row.working_dir,
      latest_minutes_path: row.latest_minutes_path,
      latest_content_sha256: row.latest_content_sha256,
      latest_version_seq: Number(row.latest_version_seq ?? 0),
      started_at: toIso(row.started_at_unix_ms) ?? new Date(row.started_at_unix_ms).toISOString(),
      ended_at: toIso(row.ended_at_unix_ms),
      last_update_at: toIso(row.last_update_at_unix_ms),
      restarted_from_minute_job_id: row.restarted_from_minute_job_id,
      last_error: row.last_error_code
        ? {
            code: row.last_error_code,
            message: row.last_error_message ?? "",
          }
        : null,
    };
  }

  private mapMinuteVersionRow(row: MinuteVersionRow): MinuteVersionRecord {
    return {
      minute_version_id: row.minute_version_id,
      minute_job_id: row.minute_job_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      seq: Number(row.seq),
      status: row.status,
      content_markdown: row.content_markdown,
      content_sha256: row.content_sha256,
      created_at: toIso(row.created_at_unix_ms) ?? new Date(row.created_at_unix_ms).toISOString(),
    };
  }

  getLatestMinuteJobRecordForMeetingRun(meetingRunId: string): MinuteJobRecord | null {
    const row = this.db
      .query(`
        SELECT *
        FROM minute_jobs
        WHERE meeting_run_id = ?
        ORDER BY started_at_unix_ms DESC
        LIMIT 1
      `)
      .get(meetingRunId) as MinuteJobRow | null;
    return row ? this.mapMinuteJobRow(row) : null;
  }

  getMinuteJobRecord(minuteJobId: string): MinuteJobRecord | null {
    const row = this.db.query("SELECT * FROM minute_jobs WHERE minute_job_id = ?").get(minuteJobId) as MinuteJobRow | null;
    return row ? this.mapMinuteJobRow(row) : null;
  }

  listRecoverableMinuteJobs(limit: number): MinuteJobRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM minute_jobs
        WHERE state IN ('starting', 'running', 'stopping', 'restarting')
        ORDER BY started_at_unix_ms DESC
        LIMIT ?
      `)
      .all(limit) as MinuteJobRow[];
    return rows.map((row) => this.mapMinuteJobRow(row));
  }

  insertMinuteJob(input: MinuteJobInsertInput): void {
    this.db
      .query(`
        INSERT INTO minute_jobs (
          minute_job_id,
          meeting_run_id,
          room_id,
          state,
          tmux_session_name,
          command,
          prompt_label,
          prompt_hash,
          user_prompt_body,
          user_final_prompt_body,
          claude_model,
          claude_effort,
          working_dir,
          latest_minutes_path,
          latest_content_sha256,
          latest_version_seq,
          started_at_unix_ms,
          ended_at_unix_ms,
          last_update_at_unix_ms,
          restarted_from_minute_job_id,
          last_error_code,
          last_error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?, NULL, NULL)
      `)
      .run(
        input.minute_job_id,
        input.meeting_run_id,
        input.room_id,
        input.state,
        input.tmux_session_name,
        input.command,
        input.prompt_label,
        input.prompt_hash,
        input.user_prompt_body,
        input.user_final_prompt_body,
        input.claude_model,
        input.claude_effort,
        input.working_dir,
        input.latest_minutes_path,
        input.started_at_unix_ms,
        input.restarted_from_minute_job_id,
      );
  }

  patchMinuteJob(minuteJobId: string, patch: MinuteJobPatch): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    if (assignments.length === 0) {
      return;
    }
    values.push(minuteJobId);
    this.db.query(`UPDATE minute_jobs SET ${assignments.join(", ")} WHERE minute_job_id = ?`).run(...values);
  }

  insertMinuteVersion(input: MinuteVersionInsertInput): void {
    this.db
      .query(`
        INSERT INTO minute_versions (
          minute_version_id,
          minute_job_id,
          meeting_run_id,
          room_id,
          seq,
          status,
          content_markdown,
          content_sha256,
          created_at_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.minute_version_id,
        input.minute_job_id,
        input.meeting_run_id,
        input.room_id,
        input.seq,
        input.status,
        input.content_markdown,
        input.content_sha256,
        input.created_at_unix_ms,
      );
    this.patchMinuteJob(input.minute_job_id, {
      latest_version_seq: input.seq,
      latest_content_sha256: input.content_sha256,
      last_update_at_unix_ms: input.created_at_unix_ms,
    });
  }

  listMinuteVersionRecordsForMeetingRun(meetingRunId: string, limit = 100): MinuteVersionRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM minute_versions
        WHERE meeting_run_id = ?
        ORDER BY created_at_unix_ms DESC
        LIMIT ?
      `)
      .all(meetingRunId, limit) as MinuteVersionRow[];
    return rows.map((row) => this.mapMinuteVersionRow(row));
  }

  getLatestMinuteVersionForMeetingRun(meetingRunId: string): MinuteVersionRecord | null {
    const row = this.db
      .query(`
        SELECT *
        FROM minute_versions
        WHERE meeting_run_id = ?
        ORDER BY created_at_unix_ms DESC
        LIMIT 1
      `)
      .get(meetingRunId) as MinuteVersionRow | null;
    return row ? this.mapMinuteVersionRow(row) : null;
  }

  getLatestMinuteVersionForMinuteJob(minuteJobId: string): MinuteVersionRecord | null {
    const row = this.db
      .query(`
        SELECT *
        FROM minute_versions
        WHERE minute_job_id = ?
        ORDER BY created_at_unix_ms DESC
        LIMIT 1
      `)
      .get(minuteJobId) as MinuteVersionRow | null;
    return row ? this.mapMinuteVersionRow(row) : null;
  }

  private mapMeetingRunRow(row: MeetingRunRow): MeetingRunRecord {
    const parsedPaths = JSON.parse(row.paths_json) as Record<string, string | null>;
    return {
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      source: "zoom",
      normalized_join_url: row.normalized_join_url,
      bot_name: row.bot_name,
      requested_by: row.requested_by,
      tags: JSON.parse(row.tags_json) as string[],
      state: row.state,
      started_at: toIso(row.started_at_unix_ms),
      ended_at: toIso(row.ended_at_unix_ms),
      created_at: toIso(row.created_at_unix_ms) ?? new Date(row.created_at_unix_ms).toISOString(),
      updated_at: toIso(row.updated_at_unix_ms) ?? new Date(row.updated_at_unix_ms).toISOString(),
      worker: this.buildWorkerSummary(row),
      paths: {
        data_dir: parsedPaths.data_dir as string,
        event_journal_path: parsedPaths.event_journal_path as string,
        archive_audio_dir: parsedPaths.archive_audio_dir as string,
        live_pcm_dir: parsedPaths.live_pcm_dir as string | null,
        worker_log_path: parsedPaths.worker_log_path as string,
        browser_log_path: parsedPaths.browser_log_path as string,
      },
      options: JSON.parse(row.options_json) as MeetingRunOptions,
      stats: this.computeStats(row.meeting_run_id),
      minutes: this.getLatestMinuteJobRecordForMeetingRun(row.meeting_run_id),
      last_error: row.last_error_code
        ? {
            code: row.last_error_code,
            message: row.last_error_message ?? "",
          }
        : null,
    };
  }

  getMeetingRunRecord(meetingRunId: string): MeetingRunRecord | null {
    const row = this.getMeetingRunRow(meetingRunId);
    return row ? this.mapMeetingRunRow(row) : null;
  }

  listMeetingRunRecords(filters: {
    state?: string | null;
    room_id?: string | null;
    from?: number | null;
    to?: number | null;
    limit: number;
  }): MeetingRunRecord[] {
    return this.listMeetingRunRows(filters).map((row) => this.mapMeetingRunRow(row));
  }

  listRecoverableMeetingRuns(limit: number): MeetingRunRecord[] {
    const rows = this.db
      .query(`
        SELECT
          mr.*,
          wh.ts_unix_ms AS heartbeat_ts_unix_ms
        FROM meeting_runs mr
        LEFT JOIN worker_heartbeats wh
          ON wh.worker_id = mr.worker_id
        WHERE mr.state IN ('pending', 'starting', 'joining', 'capturing', 'stopping')
        ORDER BY mr.created_at_unix_ms DESC
        LIMIT ?
      `)
      .all(limit) as MeetingRunRow[];
    return rows.map((row) => this.mapMeetingRunRow(row));
  }

  listRoomRecords(limit: number): RoomRecord[] {
    const rows = this.db
      .query(`
        SELECT room_id, provider, provider_room_key, display_name, normalized_join_url, created_at_unix_ms, updated_at_unix_ms
        FROM rooms
        ORDER BY updated_at_unix_ms DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      room_id: string;
      provider: "zoom";
      provider_room_key: string;
      display_name: string | null;
      normalized_join_url: string;
      created_at_unix_ms: number;
      updated_at_unix_ms: number;
    }>;
    return rows.map((row) => ({
      room_id: row.room_id,
      provider: row.provider,
      provider_room_key: row.provider_room_key,
      display_name: row.display_name,
      normalized_join_url: row.normalized_join_url,
      created_at: toIso(row.created_at_unix_ms) ?? new Date(row.created_at_unix_ms).toISOString(),
      updated_at: toIso(row.updated_at_unix_ms) ?? new Date(row.updated_at_unix_ms).toISOString(),
    }));
  }

  listEventRecords(filters: {
    meeting_run_id?: string | null;
    room_id?: string | null;
    source?: string | null;
    kind?: string | null;
    from?: number | null;
    to?: number | null;
    after_event_id?: number | null;
    limit: number;
  }): EventRecord[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.meeting_run_id) {
      where.push("meeting_run_id = ?");
      values.push(filters.meeting_run_id);
    }
    if (filters.room_id) {
      where.push("room_id = ?");
      values.push(filters.room_id);
    }
    if (filters.source) {
      where.push("source = ?");
      values.push(filters.source);
    }
    if (filters.kind) {
      where.push("kind = ?");
      values.push(filters.kind);
    }
    if (filters.from !== null && filters.from !== undefined) {
      where.push("ts_unix_ms >= ?");
      values.push(filters.from);
    }
    if (filters.to !== null && filters.to !== undefined) {
      where.push("ts_unix_ms <= ?");
      values.push(filters.to);
    }
    if (filters.after_event_id !== null && filters.after_event_id !== undefined) {
      where.push("event_id > ?");
      values.push(filters.after_event_id);
    }
    values.push(filters.limit);
    const rows = this.db
      .query(`
        SELECT *
        FROM event_log
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY event_id ASC
        LIMIT ?
      `)
      .all(...values) as Array<{
      event_id: number;
      meeting_run_id: string;
      room_id: string;
      seq: number;
      source: EventRecord["source"];
      kind: EventRecord["kind"];
      ts_unix_ms: number;
      payload_json: string;
      raw_json: string | null;
    }>;
    return rows.map((row) => ({
      event_id: row.event_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      seq: row.seq,
      source: row.source,
      kind: row.kind,
      ts: toIso(row.ts_unix_ms) ?? new Date(row.ts_unix_ms).toISOString(),
      payload: JSON.parse(row.payload_json),
      raw: row.raw_json ? JSON.parse(row.raw_json) : undefined,
    }));
  }

  listSpeechRecords(filters: {
    meeting_run_id?: string | null;
    room_id?: string | null;
    speaker_label?: string | null;
    status?: string | null;
    q?: string | null;
    from?: number | null;
    to?: number | null;
    limit: number;
  }): SpeechSegmentRecord[] {
    const useFts = Boolean(filters.q?.trim());
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.meeting_run_id) {
      where.push("ss.meeting_run_id = ?");
      values.push(filters.meeting_run_id);
    }
    if (filters.room_id) {
      where.push("ss.room_id = ?");
      values.push(filters.room_id);
    }
    if (filters.speaker_label) {
      where.push("ss.speaker_label = ?");
      values.push(filters.speaker_label);
    }
    if (filters.status) {
      where.push("ss.status = ?");
      values.push(filters.status);
    }
    if (filters.from !== null && filters.from !== undefined) {
      where.push("ss.emitted_at_unix_ms >= ?");
      values.push(filters.from);
    }
    if (filters.to !== null && filters.to !== undefined) {
      where.push("ss.emitted_at_unix_ms <= ?");
      values.push(filters.to);
    }
    if (useFts) {
      where.push("speech_segments_fts MATCH ?");
      values.push(filters.q!.trim());
    }
    values.push(filters.limit);
    const rows = this.db
      .query(`
        SELECT ss.*
        FROM speech_segments ss
        ${useFts ? "JOIN speech_segments_fts ON speech_segments_fts.speech_segment_id = ss.speech_segment_id" : ""}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ss.event_id ASC
        LIMIT ?
      `)
      .all(...values) as Array<{
      speech_segment_id: string;
      event_id: number;
      meeting_run_id: string;
      room_id: string;
      provider: SpeechSegmentRecord["provider"];
      provider_segment_id: string | null;
      text: string;
      status: SpeechSegmentRecord["status"];
      speaker_label: string | null;
      speaker_confidence: number | null;
      started_at_unix_ms: number | null;
      ended_at_unix_ms: number | null;
      emitted_at_unix_ms: number;
    }>;
    return rows.map((row) => ({
      speech_segment_id: row.speech_segment_id,
      event_id: row.event_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      provider: row.provider,
      provider_segment_id: row.provider_segment_id,
      text: row.text,
      status: row.status,
      speaker_label: row.speaker_label,
      speaker_confidence: row.speaker_confidence,
      started_at: toIso(row.started_at_unix_ms),
      ended_at: toIso(row.ended_at_unix_ms),
      emitted_at: toIso(row.emitted_at_unix_ms) ?? new Date(row.emitted_at_unix_ms).toISOString(),
    }));
  }

  listChatRecords(filters: {
    meeting_run_id?: string | null;
    room_id?: string | null;
    sender_display_name?: string | null;
    receiver_display_name?: string | null;
    q?: string | null;
    from?: number | null;
    to?: number | null;
    limit: number;
  }): ChatMessageRecord[] {
    const useFts = Boolean(filters.q?.trim());
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.meeting_run_id) {
      where.push("cm.meeting_run_id = ?");
      values.push(filters.meeting_run_id);
    }
    if (filters.room_id) {
      where.push("cm.room_id = ?");
      values.push(filters.room_id);
    }
    if (filters.sender_display_name) {
      where.push("cm.sender_display_name = ?");
      values.push(filters.sender_display_name);
    }
    if (filters.receiver_display_name) {
      where.push("cm.receiver_display_name = ?");
      values.push(filters.receiver_display_name);
    }
    if (filters.from !== null && filters.from !== undefined) {
      where.push("cm.sent_at_unix_ms >= ?");
      values.push(filters.from);
    }
    if (filters.to !== null && filters.to !== undefined) {
      where.push("cm.sent_at_unix_ms <= ?");
      values.push(filters.to);
    }
    if (useFts) {
      where.push("chat_messages_fts MATCH ?");
      values.push(filters.q!.trim());
    }
    values.push(filters.limit);
    const rows = this.db
      .query(`
        SELECT cm.*
        FROM chat_messages cm
        ${useFts ? "JOIN chat_messages_fts ON chat_messages_fts.chat_message_id = cm.chat_message_id" : ""}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY cm.event_id ASC
        LIMIT ?
      `)
      .all(...values) as Array<{
      chat_message_id: string;
      event_id: number;
      meeting_run_id: string;
      room_id: string;
      sender_display_name: string | null;
      sender_user_id: number | null;
      receiver_display_name: string | null;
      receiver_user_id: number | null;
      visibility: ChatMessageRecord["visibility"];
      text: string;
      sent_at_unix_ms: number;
      main_chat_message_id: string | null;
      thread_reply_count: number | null;
      is_thread_reply: number | null;
      is_edited: number | null;
      chat_type: string | null;
      details_json: string | null;
    }>;
    return rows.map((row) => ({
      chat_message_id: row.chat_message_id,
      event_id: row.event_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      sender_display_name: row.sender_display_name,
      sender_user_id: row.sender_user_id,
      receiver_display_name: row.receiver_display_name,
      receiver_user_id: row.receiver_user_id,
      visibility: row.visibility,
      text: row.text,
      sent_at: toIso(row.sent_at_unix_ms) ?? new Date(row.sent_at_unix_ms).toISOString(),
      main_chat_message_id: row.main_chat_message_id,
      thread_reply_count: row.thread_reply_count,
      is_thread_reply: Boolean(row.is_thread_reply),
      is_edited: Boolean(row.is_edited),
      chat_type: row.chat_type,
      details: row.details_json ? JSON.parse(row.details_json) : null,
    }));
  }

  listSpeakerSpans(meetingRunId: string, limit: number): SpeakerSpanRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM speaker_spans
        WHERE meeting_run_id = ?
        ORDER BY started_at_unix_ms ASC
        LIMIT ?
      `)
      .all(meetingRunId, limit) as Array<{
      speaker_span_id: string;
      meeting_run_id: string;
      room_id: string;
      speaker_display_name: string | null;
      started_at_unix_ms: number;
      ended_at_unix_ms: number | null;
    }>;
    return rows.map((row) => ({
      speaker_span_id: row.speaker_span_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      speaker_display_name: row.speaker_display_name,
      started_at: toIso(row.started_at_unix_ms) ?? new Date(row.started_at_unix_ms).toISOString(),
      ended_at: toIso(row.ended_at_unix_ms),
    }));
  }

  listAudioObjects(meetingRunId: string, limit: number, publicBaseUrl: string): AudioObjectRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM audio_objects
        WHERE meeting_run_id = ?
        ORDER BY chunk_seq ASC
        LIMIT ?
      `)
      .all(meetingRunId, limit) as Array<{
      audio_object_id: string;
      meeting_run_id: string;
      room_id: string;
      stream_kind: AudioObjectRecord["stream_kind"];
      content_type: string;
      codec: string | null;
      chunk_seq: number;
      byte_length: number;
      sha256_hex: string | null;
      started_at_unix_ms: number | null;
      ended_at_unix_ms: number | null;
    }>;
    return rows.map((row) => ({
      audio_object_id: row.audio_object_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      stream_kind: row.stream_kind,
      content_type: row.content_type,
      codec: row.codec,
      chunk_seq: row.chunk_seq,
      byte_length: row.byte_length,
      sha256_hex: row.sha256_hex,
      started_at: toIso(row.started_at_unix_ms),
      ended_at: toIso(row.ended_at_unix_ms),
      download_url: `${publicBaseUrl}/v1/audio-objects/${row.audio_object_id}/content`,
    }));
  }

  getAudioObjectRow(audioObjectId: string): { path: string; content_type: string } | null {
    return (this.db
      .query("SELECT path, content_type FROM audio_objects WHERE audio_object_id = ?")
      .get(audioObjectId) as { path: string; content_type: string } | null) ?? null;
  }

  getAudioObjectRecord(audioObjectId: string, publicBaseUrl: string): AudioObjectRecord | null {
    const row = this.db
      .query(`
        SELECT *
        FROM audio_objects
        WHERE audio_object_id = ?
      `)
      .get(audioObjectId) as
      | {
          audio_object_id: string;
          meeting_run_id: string;
          room_id: string;
          stream_kind: AudioObjectRecord["stream_kind"];
          content_type: string;
          codec: string | null;
          chunk_seq: number;
          byte_length: number;
          sha256_hex: string | null;
          started_at_unix_ms: number | null;
          ended_at_unix_ms: number | null;
        }
      | null;
    if (!row) {
      return null;
    }
    return {
      audio_object_id: row.audio_object_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      stream_kind: row.stream_kind,
      content_type: row.content_type,
      codec: row.codec,
      chunk_seq: row.chunk_seq,
      byte_length: row.byte_length,
      sha256_hex: row.sha256_hex,
      started_at: toIso(row.started_at_unix_ms),
      ended_at: toIso(row.ended_at_unix_ms),
      download_url: `${publicBaseUrl}/v1/audio-objects/${row.audio_object_id}/content`,
    };
  }

  listArtifacts(meetingRunId: string, limit: number, publicBaseUrl: string): ArtifactRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM artifacts
        WHERE meeting_run_id = ?
        ORDER BY created_at_unix_ms ASC
        LIMIT ?
      `)
      .all(meetingRunId, limit) as Array<{
      artifact_id: string;
      meeting_run_id: string;
      room_id: string;
      kind: ArtifactRecord["kind"];
      path: string;
      content_type: string | null;
      byte_length: number | null;
      created_at_unix_ms: number;
    }>;
    return rows.map((row) => ({
      artifact_id: row.artifact_id,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      kind: row.kind,
      path: row.path,
      content_type: row.content_type,
      byte_length: row.byte_length,
      created_at: toIso(row.created_at_unix_ms) ?? new Date(row.created_at_unix_ms).toISOString(),
      download_url: `${publicBaseUrl}/v1/artifacts/${row.artifact_id}/content`,
    }));
  }

  getArtifactRow(artifactId: string): { path: string; content_type: string | null } | null {
    return (this.db
      .query("SELECT path, content_type FROM artifacts WHERE artifact_id = ?")
      .get(artifactId) as { path: string; content_type: string | null } | null) ?? null;
  }

  search(filters: {
    q: string;
    meeting_run_id?: string | null;
    room_id?: string | null;
    from?: number | null;
    to?: number | null;
    limit: number;
  }): SearchHit[] {
    const speechWhere: string[] = ["speech_segments_fts MATCH ?", "ss.status = 'final'"];
    const speechValues: unknown[] = [filters.q];
    const chatWhere: string[] = ["chat_messages_fts MATCH ?"];
    const chatValues: unknown[] = [filters.q];

    if (filters.meeting_run_id) {
      speechWhere.push("ss.meeting_run_id = ?");
      speechValues.push(filters.meeting_run_id);
      chatWhere.push("cm.meeting_run_id = ?");
      chatValues.push(filters.meeting_run_id);
    }
    if (filters.room_id) {
      speechWhere.push("ss.room_id = ?");
      speechValues.push(filters.room_id);
      chatWhere.push("cm.room_id = ?");
      chatValues.push(filters.room_id);
    }
    if (filters.from !== null && filters.from !== undefined) {
      speechWhere.push("ss.emitted_at_unix_ms >= ?");
      speechValues.push(filters.from);
      chatWhere.push("cm.sent_at_unix_ms >= ?");
      chatValues.push(filters.from);
    }
    if (filters.to !== null && filters.to !== undefined) {
      speechWhere.push("ss.emitted_at_unix_ms <= ?");
      speechValues.push(filters.to);
      chatWhere.push("cm.sent_at_unix_ms <= ?");
      chatValues.push(filters.to);
    }

    const rows = this.db
      .query(`
        SELECT *
        FROM (
          SELECT
            'speech' AS hit_kind,
            ss.meeting_run_id,
            ss.room_id,
            ss.event_id,
            ss.text,
            snippet(speech_segments_fts, 3, '[', ']', '...', 10) AS snippet,
            ss.emitted_at_unix_ms AS ts_unix_ms
          FROM speech_segments ss
          JOIN speech_segments_fts
            ON speech_segments_fts.speech_segment_id = ss.speech_segment_id
          WHERE ${speechWhere.join(" AND ")}

          UNION ALL

          SELECT
            'chat' AS hit_kind,
            cm.meeting_run_id,
            cm.room_id,
            cm.event_id,
            cm.text,
            snippet(chat_messages_fts, 3, '[', ']', '...', 10) AS snippet,
            cm.sent_at_unix_ms AS ts_unix_ms
          FROM chat_messages cm
          JOIN chat_messages_fts
            ON chat_messages_fts.chat_message_id = cm.chat_message_id
          WHERE ${chatWhere.join(" AND ")}
        )
        ORDER BY ts_unix_ms DESC
        LIMIT ?
      `)
      .all(...speechValues, ...chatValues, filters.limit) as Array<{
      hit_kind: SearchHit["hit_kind"];
      meeting_run_id: string;
      room_id: string;
      event_id: number;
      text: string;
      snippet: string;
      ts_unix_ms: number;
    }>;

    return rows.map((row) => ({
      hit_kind: row.hit_kind,
      meeting_run_id: row.meeting_run_id,
      room_id: row.room_id,
      event_id: row.event_id,
      text: row.text,
      snippet: row.snippet,
      ts: toIso(row.ts_unix_ms) ?? new Date(row.ts_unix_ms).toISOString(),
    }));
  }

  countActiveWorkers(): number {
    const row = this.db
      .query(`
        SELECT COUNT(*) AS value
        FROM meeting_runs
        WHERE state IN ('starting', 'joining', 'capturing', 'stopping')
      `)
      .get() as { value: number };
    return Number(row.value ?? 0);
  }
}
