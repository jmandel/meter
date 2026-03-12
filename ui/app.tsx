import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type ConnectionState = "connecting" | "live" | "reconnecting";

interface WorkerSummary {
  worker_id: string;
  pid: number | null;
  ingest_port: number | null;
  cdp_port: number | null;
  status: "online" | "offline";
  last_heartbeat_at: string | null;
}

interface MeetingRunStats {
  event_count: number;
  speech_segment_count: number;
  chat_message_count: number;
  audio_object_count: number;
  archive_audio_bytes: number;
}

interface ApiErrorBody {
  code: string;
  message: string;
}

interface MeetingRunRecord {
  meeting_run_id: string;
  room_id: string;
  normalized_join_url: string;
  bot_name: string;
  requested_by: string | null;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  worker: WorkerSummary | null;
  stats: MeetingRunStats;
  last_error: ApiErrorBody | null;
}

interface SpeechSegmentRecord {
  speech_segment_id: string;
  text: string;
  status: "partial" | "final";
  speaker_label: string | null;
  started_at: string | null;
  ended_at: string | null;
  emitted_at: string;
}

interface TranscriptEntry {
  row_id: string;
  speaker_label: string | null;
  started_at: string | null;
  updated_at: string;
  committed_text: string;
  live_text: string;
  status: "streaming" | "final";
  partial_segment_id: string | null;
}

interface HealthResponse {
  ok: boolean;
  now: string;
  mode: string;
  workers: { active_count: number };
}

interface EventRecord {
  event_id: number;
  meeting_run_id: string;
  room_id: string;
  kind: string;
  source: string;
  ts: string;
  payload: any;
}

const ACTIVE_STATES = new Set(["pending", "starting", "joining", "capturing", "stopping"]);
const MAX_TRANSCRIPT_ROWS = 8;
const TRANSCRIPT_MERGE_WINDOW_MS = 20_000;

function isActive(state: string): boolean {
  return ACTIVE_STATES.has(state);
}

function sortRuns(runs: MeetingRunRecord[]): MeetingRunRecord[] {
  return [...runs].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function mergeRun(runs: MeetingRunRecord[], nextRun: MeetingRunRecord): MeetingRunRecord[] {
  const remaining = runs.filter((run) => run.meeting_run_id !== nextRun.meeting_run_id);
  return sortRuns([nextRun, ...remaining]);
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function formatTime(iso: string | null): string {
  if (!iso) {
    return "--";
  }
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatTranscriptTime(iso: string | null): string {
  if (!iso) {
    return "--:--:--";
  }
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) {
    return "--";
  }
  const elapsedMs = Math.max(0, (endIso ? Date.parse(endIso) : Date.now()) - Date.parse(startIso));
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatRoomLabel(roomId: string): string {
  const [provider, providerRoomKey] = roomId.split(":", 2);
  if (provider === "zoom" && providerRoomKey) {
    return `Zoom ${providerRoomKey}`;
  }
  return roomId;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appendRecentEvent(events: EventRecord[], nextEvent: EventRecord): EventRecord[] {
  const deduped = [nextEvent, ...events.filter((event) => event.event_id !== nextEvent.event_id)];
  return deduped.slice(0, 14);
}

function normalizeSpeakerLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function joinTranscriptText(left: string, right: string): string {
  const start = left.trim();
  const end = right.trim();
  if (!start) {
    return end;
  }
  if (!end) {
    return start;
  }
  if (start.endsWith("-") || /^[,.;:!?)]/.test(end)) {
    return `${start}${end}`;
  }
  return `${start} ${end}`;
}

function transcriptEntryText(entry: TranscriptEntry): string {
  return joinTranscriptText(entry.committed_text, entry.live_text);
}

function shouldMergeTranscriptEntry(entry: TranscriptEntry, segment: SpeechSegmentRecord): boolean {
  const entrySpeaker = normalizeSpeakerLabel(entry.speaker_label);
  const segmentSpeaker = normalizeSpeakerLabel(segment.speaker_label);
  const anchorIso = entry.updated_at || entry.started_at;
  const segmentIso = segment.started_at ?? segment.emitted_at;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  const segmentMs = Date.parse(segmentIso);
  const inWindow = !Number.isFinite(anchorMs) || !Number.isFinite(segmentMs)
    ? true
    : Math.abs(segmentMs - anchorMs) <= TRANSCRIPT_MERGE_WINDOW_MS;
  if (!inWindow) {
    return false;
  }
  if (entry.status === "streaming") {
    return entrySpeaker === segmentSpeaker || !entrySpeaker || !segmentSpeaker;
  }
  if (!entrySpeaker || !segmentSpeaker) {
    return false;
  }
  return entrySpeaker === segmentSpeaker;
}

function trimTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.slice(-MAX_TRANSCRIPT_ROWS);
}

function appendTranscriptEvent(entries: TranscriptEntry[], segment: SpeechSegmentRecord): TranscriptEntry[] {
  const nextEntries = [...entries];
  const lastEntry = nextEntries[nextEntries.length - 1];

  if (segment.status === "partial") {
    const existingIndex = nextEntries.findIndex((entry) => entry.partial_segment_id === segment.speech_segment_id);
    if (existingIndex >= 0) {
      const entry = nextEntries[existingIndex];
      entry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? entry.speaker_label;
      entry.started_at = entry.started_at ?? segment.started_at ?? segment.emitted_at;
      entry.updated_at = segment.emitted_at;
      entry.live_text = segment.text;
      entry.status = "streaming";
      return trimTranscriptEntries(nextEntries);
    }

    if (lastEntry && shouldMergeTranscriptEntry(lastEntry, segment)) {
      if (lastEntry.partial_segment_id && lastEntry.partial_segment_id !== segment.speech_segment_id && lastEntry.live_text) {
        lastEntry.committed_text = joinTranscriptText(lastEntry.committed_text, lastEntry.live_text);
      }
      lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
      lastEntry.started_at = lastEntry.started_at ?? segment.started_at ?? segment.emitted_at;
      lastEntry.updated_at = segment.emitted_at;
      lastEntry.partial_segment_id = segment.speech_segment_id;
      lastEntry.live_text = segment.text;
      lastEntry.status = "streaming";
      return trimTranscriptEntries(nextEntries);
    }

    nextEntries.push({
      row_id: segment.speech_segment_id,
      speaker_label: normalizeSpeakerLabel(segment.speaker_label),
      started_at: segment.started_at ?? segment.emitted_at,
      updated_at: segment.emitted_at,
      committed_text: "",
      live_text: segment.text,
      status: "streaming",
      partial_segment_id: segment.speech_segment_id,
    });
    return trimTranscriptEntries(nextEntries);
  }

  if (lastEntry && lastEntry.status === "streaming" && shouldMergeTranscriptEntry(lastEntry, segment)) {
    lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
    lastEntry.started_at = lastEntry.started_at ?? segment.started_at ?? segment.emitted_at;
    lastEntry.updated_at = segment.emitted_at;
    lastEntry.committed_text = joinTranscriptText(lastEntry.committed_text, segment.text);
    lastEntry.live_text = "";
    lastEntry.partial_segment_id = null;
    lastEntry.status = "final";
    return trimTranscriptEntries(nextEntries);
  }

  if (lastEntry && shouldMergeTranscriptEntry(lastEntry, segment)) {
    lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
    lastEntry.started_at = lastEntry.started_at ?? segment.started_at ?? segment.emitted_at;
    lastEntry.updated_at = segment.emitted_at;
    lastEntry.committed_text = joinTranscriptText(transcriptEntryText(lastEntry), segment.text);
    lastEntry.live_text = "";
    lastEntry.partial_segment_id = null;
    lastEntry.status = "final";
    return trimTranscriptEntries(nextEntries);
  }

  nextEntries.push({
    row_id: segment.speech_segment_id,
    speaker_label: normalizeSpeakerLabel(segment.speaker_label),
    started_at: segment.started_at ?? segment.emitted_at,
    updated_at: segment.emitted_at,
    committed_text: segment.text,
    live_text: "",
    status: "final",
    partial_segment_id: null,
  });
  return trimTranscriptEntries(nextEntries);
}

function buildTranscriptPreview(segments: SpeechSegmentRecord[]): TranscriptEntry[] {
  return segments.reduce<TranscriptEntry[]>((entries, segment) => appendTranscriptEvent(entries, segment), []);
}

function speakerFromEvent(event: EventRecord): string | null {
  return normalizeSpeakerLabel(event.payload?.speaker_label ?? event.payload?.speaker_display_name ?? null);
}

function summarizeEvent(event: EventRecord): { title: string; detail: string } {
  switch (event.kind) {
    case "system.meeting_run.created":
      return {
        title: "Capture requested",
        detail: event.payload?.join_url ?? formatRoomLabel(event.room_id),
      };
    case "system.worker.started":
      return {
        title: "Capture starting",
        detail: formatRoomLabel(event.room_id),
      };
    case "system.worker.completed":
      return {
        title: "Capture finished",
        detail: formatRoomLabel(event.room_id),
      };
    case "system.worker.failed":
      return {
        title: "Capture failed",
        detail: event.payload?.message ?? formatRoomLabel(event.room_id),
      };
    case "audio.capture.started":
      return {
        title: "Capture live",
        detail: formatRoomLabel(event.room_id),
      };
    case "audio.capture.stopped":
      return {
        title: "Capture stopped",
        detail: event.payload?.reason ?? formatRoomLabel(event.room_id),
      };
    case "transcription.segment.final":
      return {
        title: event.payload?.speaker_label ? `${event.payload.speaker_label}` : "Transcript update",
        detail: event.payload?.text ?? "",
      };
    case "zoom.chat.message":
      return {
        title: event.payload?.sender_display_name ? `${event.payload.sender_display_name}` : "Chat",
        detail: event.payload?.text ?? "",
      };
    case "zoom.speaker.active":
      return {
        title: "Active speaker",
        detail: event.payload?.speaker_display_name ?? "Unknown speaker",
      };
    case "error.raised":
      return {
        title: event.payload?.code ?? "Issue",
        detail: event.payload?.message ?? "Worker reported an error",
      };
    default:
      return {
        title: event.kind.replaceAll(".", " "),
        detail: shortId(event.meeting_run_id),
      };
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchSpeechPreview(meetingRunId: string): Promise<TranscriptEntry[]> {
  const response = await fetchJson<{ items: SpeechSegmentRecord[] }>(
    `/v1/meeting-runs/${meetingRunId}/speech?status=final&limit=24`,
  );
  return buildTranscriptPreview([...response.items].reverse());
}

function StatusPill({
  tone,
  label,
  value,
}: {
  tone: "live" | "warn" | "neutral";
  label: string;
  value: string;
}) {
  return (
    <div className={`status-pill tone-${tone}`}>
      <span className="status-label">{label}</span>
      <span className="status-value">{value}</span>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const label = state === "capturing" ? "live" : state;
  return <span className={`state-badge state-${state}`}>{label}</span>;
}

function Screenshot({ meetingRunId }: { meetingRunId: string }) {
  const [tick, setTick] = useState(0);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setHasError(false);
      setTick((value) => value + 1);
    }, 12000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="screenshot-frame">
      {hasError ? (
        <div className="screenshot-empty">Live preview unavailable</div>
      ) : (
        <img
          src={`/v1/meeting-runs/${meetingRunId}/screenshot?v=${tick}`}
          alt="Meeting preview"
          onError={() => setHasError(true)}
        />
      )}
    </div>
  );
}

function NewCapture({
  onCreated,
}: {
  onCreated: (run: MeetingRunRecord) => void;
}) {
  const [joinUrl, setJoinUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!joinUrl.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await postJson<{ meeting_run: MeetingRunRecord }>("/v1/meeting-runs", {
        join_url: joinUrl.trim(),
        bot_name: botName.trim() || undefined,
      });
      setJoinUrl("");
      setBotName("");
      onCreated(response.meeting_run);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create meeting run");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel capture-panel">
      <div className="panel-heading">
        <p className="eyebrow">Start capture</p>
        <h2>Start Zoom capture</h2>
      </div>
      <form className="capture-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Zoom meeting URL</span>
          <input
            type="text"
            placeholder="https://zoom.us/j/123456789?pwd=..."
            value={joinUrl}
            disabled={submitting}
            onChange={(inputEvent) => setJoinUrl(inputEvent.target.value)}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            placeholder="Meeting Bot"
            value={botName}
            disabled={submitting}
            onChange={(inputEvent) => setBotName(inputEvent.target.value)}
          />
        </label>
        <p className="field-hint">Starts immediately. Paste a Zoom link and choose the name shown in the meeting.</p>
        {error ? <div className="inline-error">{error}</div> : null}
        <button className="primary-button" disabled={submitting || !joinUrl.trim()} type="submit">
          {submitting ? "Starting capture..." : "Start capture"}
        </button>
      </form>
    </section>
  );
}

function OverviewPanel({
  health,
  connectionState,
  activeCount,
  totalCount,
}: {
  health: HealthResponse | null;
  connectionState: ConnectionState;
  activeCount: number;
  totalCount: number;
}) {
  return (
    <section className="panel overview-panel">
      <div className="panel-heading">
        <p className="eyebrow">System status</p>
        <h2>Capture status</h2>
      </div>
      <div className="status-grid">
        <StatusPill
          tone={connectionState === "live" ? "live" : "warn"}
          label="Connection"
          value={connectionState === "live" ? "live" : connectionState}
        />
        <StatusPill
          tone={health?.ok ? "live" : "warn"}
          label="API"
          value={health?.ok ? "healthy" : "checking"}
        />
      </div>
      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">Active captures</span>
          <strong className="metric-value">{activeCount}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Total captures</span>
          <strong className="metric-value">{totalCount}</strong>
        </div>
      </div>
    </section>
  );
}

function ActivityFeed({ events }: { events: EventRecord[] }) {
  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <p className="eyebrow">Live feed</p>
        <h2>Recent activity</h2>
      </div>
      {events.length === 0 ? (
        <div className="empty-panel">No recent activity yet.</div>
      ) : (
        <div className="activity-list">
          {events.map((event) => {
            const summary = summarizeEvent(event);
            return (
              <article className="activity-item" key={event.event_id}>
                <div className="activity-meta">
                  <span className="activity-kind">{summary.title}</span>
                  <span className="activity-time">{formatTime(event.ts)}</span>
                </div>
                <p className="activity-detail">{summary.detail}</p>
                <span className="activity-run">Capture {shortId(event.meeting_run_id)}</span>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LiveRunCard({
  run,
  transcript,
  onStopped,
}: {
  run: MeetingRunRecord;
  transcript: TranscriptEntry[];
  onStopped: () => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStop = async () => {
    setStopping(true);
    setError(null);
    try {
      await onStopped();
    } catch (stopError) {
      setStopping(false);
      setError(stopError instanceof Error ? stopError.message : "Failed to stop meeting run");
    }
  };

  useEffect(() => {
    if (run.state !== "stopping") {
      setStopping(false);
    }
  }, [run.state]);

  return (
    <article className="run-card">
      <div className="run-card-head">
        <div>
          <div className="run-card-meta">
            <span className="run-id">{shortId(run.meeting_run_id)}</span>
            <StateBadge state={run.state} />
          </div>
          <h3>{formatRoomLabel(run.room_id)}</h3>
          <p className="run-subtitle">Joined as {run.bot_name}</p>
        </div>
        <button
          className="ghost-button ghost-danger"
          disabled={stopping || run.state === "stopping"}
          onClick={handleStop}
          type="button"
        >
          {stopping ? "Stopping..." : "Stop"}
        </button>
      </div>

      <div className="run-card-body">
        <Screenshot meetingRunId={run.meeting_run_id} />
        <div className="run-details">
          <dl className="detail-list">
            <div>
              <dt>Started</dt>
              <dd>{formatTime(run.started_at ?? run.created_at)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(run.started_at ?? run.created_at, run.ended_at)}</dd>
            </div>
            <div>
              <dt>Display name</dt>
              <dd>{run.bot_name}</dd>
            </div>
            <div>
              <dt>Meeting URL</dt>
              <dd className="url-value">{run.normalized_join_url}</dd>
            </div>
          </dl>

          <div className="run-kpis">
            <div>
              <span>Events</span>
              <strong>{run.stats.event_count}</strong>
            </div>
            <div>
              <span>Speech</span>
              <strong>{run.stats.speech_segment_count}</strong>
            </div>
            <div>
              <span>Chat</span>
              <strong>{run.stats.chat_message_count}</strong>
            </div>
            <div>
              <span>Archive</span>
              <strong>{formatBytes(run.stats.archive_audio_bytes)}</strong>
            </div>
          </div>

          {run.last_error ? (
            <div className="inline-error">
              {run.last_error.code}: {run.last_error.message}
            </div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}

          <div className="transcript-panel">
            <div className="transcript-head">
              <div className="transcript-heading">Live transcript</div>
              <a
                className="transcript-link"
                href={`/v1/meeting-runs/${run.meeting_run_id}/transcript.md`}
                rel="noreferrer"
                target="_blank"
              >
                Open markdown
              </a>
            </div>
            {transcript.length === 0 ? (
              <div className="transcript-empty">Waiting for transcript activity.</div>
            ) : (
              <div className="transcript-stream">
                {transcript.map((entry) => (
                  <article
                    className={`transcript-entry transcript-${entry.status}`}
                    key={entry.row_id}
                  >
                    <div className="transcript-meta">
                      <span className="transcript-time">
                        {formatTranscriptTime(entry.started_at ?? entry.updated_at)}
                      </span>
                      <span className="transcript-speaker">
                        {entry.speaker_label ?? "Unknown speaker"}
                      </span>
                      <span className={`transcript-status transcript-status-${entry.status}`}>
                        {entry.status === "streaming" ? "live" : "done"}
                      </span>
                    </div>
                    <p>{transcriptEntryText(entry)}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function LiveRuns({
  runs,
  transcriptsByRun,
  onStopRun,
}: {
  runs: MeetingRunRecord[];
  transcriptsByRun: Record<string, TranscriptEntry[]>;
  onStopRun: (meetingRunId: string) => Promise<void>;
}) {
  return (
    <section className="content-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Active captures</p>
          <h2>Zoom captures in progress</h2>
        </div>
        <span className="section-count">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <div className="empty-panel">
          <strong className="empty-title">No active captures</strong>
          <p className="empty-copy">Start a Zoom capture from the left panel. Meter joins as soon as you submit a meeting URL.</p>
        </div>
      ) : (
        <div className="run-grid">
          {runs.map((run) => (
            <LiveRunCard
              key={run.meeting_run_id}
              run={run}
              transcript={transcriptsByRun[run.meeting_run_id] ?? []}
              onStopped={() => onStopRun(run.meeting_run_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryTable({ runs }: { runs: MeetingRunRecord[] }) {
  return (
    <section className="content-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">History</p>
          <h2>Capture history</h2>
        </div>
        <span className="section-count">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <div className="empty-panel">No completed captures yet.</div>
      ) : (
        <div className="history-shell">
          <table className="history-table">
            <thead>
              <tr>
                <th>Meeting</th>
                <th>Name</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Speech</th>
                <th>Chat</th>
                <th>Archive</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.meeting_run_id}>
                  <td>
                    <div className="history-cell">
                      <span>{formatRoomLabel(run.room_id)}</span>
                      <small>Capture {shortId(run.meeting_run_id)}</small>
                      <a
                        className="history-link"
                        href={`/v1/meeting-runs/${run.meeting_run_id}/transcript.md`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open transcript
                      </a>
                    </div>
                  </td>
                  <td>{run.bot_name}</td>
                  <td><StateBadge state={run.state} /></td>
                  <td>{formatTime(run.started_at ?? run.created_at)}</td>
                  <td>{formatDuration(run.started_at ?? run.created_at, run.ended_at)}</td>
                  <td>{run.stats.speech_segment_count}</td>
                  <td>{run.stats.chat_message_count}</td>
                  <td>{formatBytes(run.stats.archive_audio_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function App() {
  const [runs, setRuns] = useState<MeetingRunRecord[]>([]);
  const [transcriptsByRun, setTranscriptsByRun] = useState<Record<string, TranscriptEntry[]>>({});
  const [recentEvents, setRecentEvents] = useState<EventRecord[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [pageError, setPageError] = useState<string | null>(null);
  const refreshQueueRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<number | null>(null);
  const activeSpeakerByRunRef = useRef<Record<string, string | null>>({});

  const refreshRun = useCallback(async (meetingRunId: string) => {
    const response = await fetchJson<{ meeting_run: MeetingRunRecord }>(`/v1/meeting-runs/${meetingRunId}`);
    setRuns((currentRuns) => mergeRun(currentRuns, response.meeting_run));

    if (isActive(response.meeting_run.state)) {
      let shouldLoadPreview = false;
      setTranscriptsByRun((current) => {
        shouldLoadPreview = !current[meetingRunId] || current[meetingRunId].length === 0;
        return current;
      });
      if (shouldLoadPreview) {
        const preview = await fetchSpeechPreview(meetingRunId).catch(() => []);
        setTranscriptsByRun((current) => ({
          ...current,
          [meetingRunId]: preview,
        }));
      }
      return;
    }

    setTranscriptsByRun((current) => {
      if (!(meetingRunId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[meetingRunId];
      return next;
    });
  }, []);

  const queueRunRefresh = useCallback((meetingRunId: string) => {
    refreshQueueRef.current.add(meetingRunId);
    if (refreshTimerRef.current !== null) {
      return;
    }
    refreshTimerRef.current = window.setTimeout(async () => {
      const meetingRunIds = [...refreshQueueRef.current];
      refreshQueueRef.current.clear();
      refreshTimerRef.current = null;
      await Promise.all(meetingRunIds.map((value) => refreshRun(value).catch(() => undefined)));
    }, 250);
  }, [refreshRun]);

  const loadDashboard = useCallback(async () => {
    const [runsResponse, healthResponse] = await Promise.all([
      fetchJson<{ items: MeetingRunRecord[] }>("/v1/meeting-runs?limit=200"),
      fetchJson<HealthResponse>("/v1/health"),
    ]);
    const orderedRuns = sortRuns(runsResponse.items);
    setRuns(orderedRuns);
    setHealth(healthResponse);

    const previewEntries = await Promise.all(
      orderedRuns
        .filter((run) => isActive(run.state))
        .map(async (run) => [run.meeting_run_id, await fetchSpeechPreview(run.meeting_run_id).catch(() => [])] as const),
    );
    setTranscriptsByRun(Object.fromEntries(previewEntries));
    setPageError(null);
  }, []);

  useEffect(() => {
    void loadDashboard().catch((error) => {
      setPageError(error instanceof Error ? error.message : "Failed to load dashboard");
    });
  }, [loadDashboard]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchJson<HealthResponse>("/v1/health")
        .then((response) => setHealth(response))
        .catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const eventSource = new EventSource("/v1/stream");

    eventSource.onopen = () => {
      setConnectionState("live");
    };

    eventSource.onerror = () => {
      setConnectionState("reconnecting");
    };

    const handleHeartbeat = () => {
      setConnectionState("live");
    };

    const handleEvent = (message: MessageEvent) => {
      setConnectionState("live");
      const payload = JSON.parse(message.data) as { event_id: number; event: EventRecord };
      const event = payload.event;
      setRecentEvents((current) => appendRecentEvent(current, event));
      if (event.kind === "zoom.speaker.active") {
        activeSpeakerByRunRef.current[event.meeting_run_id] = speakerFromEvent(event);
      }
      if (event.kind === "transcription.segment.partial" || event.kind === "transcription.segment.final") {
        const payload = event.payload as {
          speech_segment_id: string;
          text: string;
          status: "partial" | "final";
          speaker_label?: string | null;
          started_at_unix_ms?: number | null;
          ended_at_unix_ms?: number | null;
        };
        const segment: SpeechSegmentRecord = {
          speech_segment_id: payload.speech_segment_id,
          text: payload.text,
          status: payload.status,
          speaker_label: normalizeSpeakerLabel(payload.speaker_label) ?? activeSpeakerByRunRef.current[event.meeting_run_id] ?? null,
          started_at: payload.started_at_unix_ms ? new Date(payload.started_at_unix_ms).toISOString() : null,
          ended_at: payload.ended_at_unix_ms ? new Date(payload.ended_at_unix_ms).toISOString() : null,
          emitted_at: event.ts,
        };
        setTranscriptsByRun((current) => ({
          ...current,
          [event.meeting_run_id]: appendTranscriptEvent(current[event.meeting_run_id] ?? [], segment),
        }));
      }
      if (event.kind !== "system.worker.heartbeat") {
        queueRunRefresh(event.meeting_run_id);
      }
    };

    eventSource.addEventListener("heartbeat", handleHeartbeat);
    eventSource.addEventListener("event", handleEvent as EventListener);

    return () => {
      eventSource.removeEventListener("heartbeat", handleHeartbeat);
      eventSource.removeEventListener("event", handleEvent as EventListener);
      eventSource.close();
    };
  }, [queueRunRefresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const activeRuns = useMemo(
    () => runs.filter((run) => isActive(run.state)),
    [runs],
  );
  const historyRuns = useMemo(
    () => runs.filter((run) => !isActive(run.state)),
    [runs],
  );

  const handleCreated = (run: MeetingRunRecord) => {
    setRuns((currentRuns) => mergeRun(currentRuns, run));
    queueRunRefresh(run.meeting_run_id);
  };

  const handleStopRun = async (meetingRunId: string) => {
    await postJson(`/v1/meeting-runs/${meetingRunId}/stop`, {});
    queueRunRefresh(meetingRunId);
  };

  return (
    <div className="app-shell">
      <header className="page-header">
        <div className="header-copy">
          <p className="eyebrow">Zoom capture dashboard</p>
          <h1><span className="brand-mark">Meter</span> Control Room</h1>
          <p className="header-summary">
            Start Zoom captures, follow live status, and review transcript activity in one place.
          </p>
        </div>
      </header>

      {pageError ? <div className="banner-error">{pageError}</div> : null}

      <main className="page-layout">
        <aside className="sidebar">
          <NewCapture onCreated={handleCreated} />
          <OverviewPanel
            health={health}
            connectionState={connectionState}
            activeCount={activeRuns.length}
            totalCount={runs.length}
          />
          <ActivityFeed events={recentEvents} />
        </aside>

        <section className="main-column">
          <LiveRuns runs={activeRuns} transcriptsByRun={transcriptsByRun} onStopRun={handleStopRun} />
          <HistoryTable runs={historyRuns} />
        </section>
      </main>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

createRoot(rootElement).render(<App />);
