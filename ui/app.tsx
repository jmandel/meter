import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  listMinutePromptTemplates,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import {
  MINUTE_CLAUDE_EFFORT_OPTIONS,
  MINUTE_CLAUDE_MODEL_SUGGESTIONS,
  MINUTE_OPENROUTER_MODEL_SUGGESTIONS,
  type MinuteDraftFields,
  type MinutePresetSource,
  type UiMinuteClaudeEffort,
  type UiMinuteProvider,
  minutePromptRequestBody,
  useMinutePresetDraftManager,
} from "./minute-prompt-drafts";

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
  minutes?: MinuteJobRecord | null;
  last_error: ApiErrorBody | null;
}

interface MinuteJobRecord {
  minute_job_id: string;
  meeting_run_id: string;
  room_id: string;
  state: "idle" | "starting" | "running" | "stopping" | "restarting" | "completed" | "failed";
  provider: UiMinuteProvider;
  tmux_session_name: string | null;
  prompt_template_id: string | null;
  prompt_label: string | null;
  prompt_hash: string | null;
  user_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: "low" | "medium" | "high" | "max" | null;
  openrouter_model: string | null;
  latest_version_seq: number;
  started_at: string;
  ended_at: string | null;
  last_update_at: string | null;
}

interface MinutePromptTemplatesResponse {
  default_provider?: UiMinuteProvider;
  default_openrouter_model?: string | null;
  items: MinutePromptTemplate[];
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
const BUILTIN_MINUTE_PROMPT_TEMPLATES = listMinutePromptTemplates();

function isActiveRun(run: MeetingRunRecord): boolean {
  if (!ACTIVE_STATES.has(run.state)) {
    return false;
  }
  if (run.state === "pending") {
    return true;
  }
  return run.worker ? run.worker.status === "online" : true;
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

function AutoGrowTextarea({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className={className}
      disabled={disabled}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
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
  minuteTemplates,
  defaultMinuteProvider,
  defaultOpenRouterModel,
}: {
  onCreated: (run: MeetingRunRecord) => void;
  minuteTemplates: MinutePromptTemplate[];
  defaultMinuteProvider: UiMinuteProvider;
  defaultOpenRouterModel: string;
}) {
  const enabledStorageKey = "meter:new-capture:minutes:enabled";
  const [joinUrl, setJoinUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [minutesEnabled, setMinutesEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minuteDraft = useMinutePresetDraftManager({
    templates: minuteTemplates,
    runningFields: null,
    runningPromptLabel: null,
    preferRunningPreset: false,
    defaultProvider: defaultMinuteProvider,
    defaultOpenRouterModel,
  });

  useEffect(() => {
    setMinutesEnabled(window.localStorage.getItem(enabledStorageKey) === "1");
  }, [enabledStorageKey]);

  useEffect(() => {
    window.localStorage.setItem(enabledStorageKey, minutesEnabled ? "1" : "0");
  }, [enabledStorageKey, minutesEnabled]);

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
      let createdRun = response.meeting_run;
      let minuteStartError: string | null = null;
      if (minutesEnabled) {
        try {
          await postJson(
            `/v1/meeting-runs/${createdRun.meeting_run_id}/minutes/start`,
            minutePromptRequestBody(minuteTemplates, minuteDraft.currentFields, minuteDraft.promptLabel, defaultMinuteProvider),
          );
          const refreshed = await fetchJson<{ meeting_run: MeetingRunRecord }>(`/v1/meeting-runs/${createdRun.meeting_run_id}`);
          createdRun = refreshed.meeting_run;
        } catch (minuteError) {
          minuteStartError = minuteError instanceof Error ? minuteError.message : "Failed to start minutes";
        }
      }
      setJoinUrl("");
      setBotName("");
      onCreated(createdRun);
      if (minuteStartError) {
        setError(`Capture started, but minutes did not start: ${minuteStartError}`);
      }
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
          <span>Zoom meeting</span>
          <input
            type="text"
            placeholder="2193058682 or https://zoom.us/j/123456789?pwd=..."
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
        <label className="field-toggle">
          <input
            checked={minutesEnabled}
            disabled={submitting}
            onChange={(inputEvent) => setMinutesEnabled(inputEvent.target.checked)}
            type="checkbox"
          />
          <span>Start live minutes too</span>
        </label>
        {minutesEnabled ? (
          <>
            <div className="minutes-preset-row">
              <label className="field minutes-preset-picker">
                <span>Prompt preset</span>
                <select
                  value={minuteDraft.selectedSource}
                  disabled={submitting}
                  onChange={(inputEvent) => minuteDraft.selectSource(inputEvent.target.value as MinutePresetSource)}
                >
                  {minuteTemplates.map((template) => (
                    <option key={template.template_id} value={`template:${template.template_id}`}>
                      {template.name}
                    </option>
                  ))}
                  {minuteDraft.presets.map((preset) => (
                    <option key={preset.name} value={`preset:${preset.name}`}>
                      Local preset: {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className={`minutes-draft ${minuteDraft.hasUnsavedChanges ? "minutes-draft-dirty" : "minutes-draft-clean"}`}>
                {minuteDraft.hasUnsavedChanges ? "Unsaved local preset changes" : `Using ${minuteDraft.selectedLabel}`}
              </span>
              {minuteDraft.selectedPresetName && !minuteDraft.hasUnsavedChanges ? (
                <button className="ghost-button" disabled={submitting} onClick={minuteDraft.deleteSelectedPreset} type="button">
                  Delete preset
                </button>
              ) : null}
            </div>
            {minuteDraft.hasUnsavedChanges ? (
              <div className="minutes-preset-save">
                <label className="field minutes-preset-name">
                  <span>Save local preset as</span>
                  <input
                    type="text"
                    placeholder="Weekly FHIR WG"
                    value={minuteDraft.presetNameDraft}
                    disabled={submitting}
                    onChange={(inputEvent) => minuteDraft.setPresetNameDraft(inputEvent.target.value)}
                  />
                </label>
                <div className="minutes-preset-actions">
                  <button className="secondary-button" disabled={submitting} onClick={minuteDraft.savePreset} type="button">
                    Save preset
                  </button>
                  <button className="ghost-button" disabled={submitting} onClick={minuteDraft.resetDraftToSelected} type="button">
                    Revert draft
                  </button>
                </div>
                {minuteDraft.presetError ? <div className="inline-error">{minuteDraft.presetError}</div> : null}
              </div>
            ) : null}
            {minuteDraft.selectedTemplate ? (
              <p className="field-hint">{minuteDraft.selectedTemplate.description}</p>
            ) : null}
            <label className="field">
              <span>Minute prompt</span>
              <AutoGrowTextarea
                className="auto-grow-textarea"
                value={minuteDraft.promptBody}
                disabled={submitting}
                onChange={minuteDraft.setPromptBody}
              />
            </label>
            {minuteDraft.provider === "claude_tmux" ? (
              <div className="minutes-config-grid">
                <label className="field">
                  <span>Claude model</span>
                  <select
                    value={minuteDraft.claudeModel}
                    disabled={submitting}
                    onChange={(inputEvent) => minuteDraft.setClaudeModel(inputEvent.target.value)}
                  >
                    <option value="">Server default</option>
                    {MINUTE_CLAUDE_MODEL_SUGGESTIONS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Claude effort</span>
                  <select
                    value={minuteDraft.claudeEffort}
                    disabled={submitting}
                    onChange={(inputEvent) => minuteDraft.setClaudeEffort(inputEvent.target.value as UiMinuteClaudeEffort)}
                  >
                    <option value="">Server default</option>
                    {MINUTE_CLAUDE_EFFORT_OPTIONS.filter((value) => value).map((value) => (
                      <option key={value} value={value}>{value[0].toUpperCase()}{value.slice(1)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <div className="minutes-config-grid">
                <label className="field">
                  <span>OpenRouter model</span>
                  <select
                    value={minuteDraft.openrouterModel}
                    disabled={submitting}
                    onChange={(inputEvent) => minuteDraft.setOpenRouterModel(inputEvent.target.value)}
                  >
                    <option value="">Server default</option>
                    {MINUTE_OPENROUTER_MODEL_SUGGESTIONS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        ) : null}
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

function LiveRunCard({
  run,
  onStopped,
  onMinutesChanged,
}: {
  run: MeetingRunRecord;
  onStopped: () => Promise<void>;
  onMinutesChanged: () => void;
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

          <div className="record-links-card">
            <div className="transcript-heading">Records</div>
            <div className="record-links-list">
              <div className="record-link-row">
                <div>
                  <strong>Transcript</strong>
                  <span>{run.stats.speech_segment_count} finalized segments</span>
                </div>
                <a
                  className="action-link"
                  href={`/v1/meeting-runs/${run.meeting_run_id}/transcript/view`}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open transcript
                </a>
              </div>
              <div className="record-link-row">
                <div>
                  <strong>Minutes</strong>
                  <span>
                    {run.minutes
                      ? `State: ${run.minutes.state}${run.minutes.last_update_at ? ` · updated ${formatTime(run.minutes.last_update_at)}` : ""}`
                      : "Not running for this capture"}
                  </span>
                </div>
                <div className="record-link-actions">
                  <a
                    className="action-link"
                    href={`/v1/meeting-runs/${run.meeting_run_id}/minutes/view`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {run.minutes ? "Open minute workspace" : "Start minutes"}
                  </a>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </article>
  );
}

function LiveRuns({
  runs,
  onStopRun,
  onMinutesChanged,
}: {
  runs: MeetingRunRecord[];
  onStopRun: (meetingRunId: string) => Promise<void>;
  onMinutesChanged: (meetingRunId: string) => void;
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
              onStopped={() => onStopRun(run.meeting_run_id)}
              onMinutesChanged={() => onMinutesChanged(run.meeting_run_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryRow({
  run,
  onMinutesChanged: _onMinutesChanged,
}: {
  run: MeetingRunRecord;
  onMinutesChanged: (meetingRunId: string) => void;
}) {
  return (
    <tr>
      <td>
        <div className="history-cell">
          <span>{formatRoomLabel(run.room_id)}</span>
          <small>Capture {shortId(run.meeting_run_id)}</small>
          <div className="history-actions">
            <a
              className="history-action"
              href={`/v1/meeting-runs/${run.meeting_run_id}/transcript/view`}
              rel="noreferrer"
              target="_blank"
            >
              Open transcript
            </a>
            <a
              className="history-action"
              href={`/v1/meeting-runs/${run.meeting_run_id}/minutes/view`}
              rel="noreferrer"
              target="_blank"
            >
              {run.minutes ? "Open minute workspace" : "Start minutes"}
            </a>
          </div>
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
  );
}

function HistoryTable({
  runs,
  onMinutesChanged,
}: {
  runs: MeetingRunRecord[];
  onMinutesChanged: (meetingRunId: string) => void;
}) {
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
                <HistoryRow
                  key={run.meeting_run_id}
                  onMinutesChanged={onMinutesChanged}
                  run={run}
                />
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [minuteTemplates, setMinuteTemplates] = useState<MinutePromptTemplate[]>(BUILTIN_MINUTE_PROMPT_TEMPLATES);
  const [defaultMinuteProvider, setDefaultMinuteProvider] = useState<UiMinuteProvider>("claude_tmux");
  const [defaultOpenRouterModel, setDefaultOpenRouterModel] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [pageError, setPageError] = useState<string | null>(null);
  const refreshQueueRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<number | null>(null);

  const refreshRun = useCallback(async (meetingRunId: string) => {
    const response = await fetchJson<{ meeting_run: MeetingRunRecord }>(`/v1/meeting-runs/${meetingRunId}`);
    setRuns((currentRuns) => mergeRun(currentRuns, response.meeting_run));
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
    const [runsResponse, healthResponse, templatesResponse] = await Promise.all([
      fetchJson<{ items: MeetingRunRecord[] }>("/v1/meeting-runs?limit=200"),
      fetchJson<HealthResponse>("/v1/health"),
      fetchJson<MinutePromptTemplatesResponse>("/v1/minute-prompt-templates")
        .catch(() => ({ items: BUILTIN_MINUTE_PROMPT_TEMPLATES })),
    ]);
    const orderedRuns = sortRuns(runsResponse.items);
    setRuns(orderedRuns);
    setHealth(healthResponse);
    setMinuteTemplates(templatesResponse.items.length > 0 ? templatesResponse.items : BUILTIN_MINUTE_PROMPT_TEMPLATES);
    setDefaultMinuteProvider(templatesResponse.default_provider === "openrouter_patch" ? "openrouter_patch" : "claude_tmux");
    setDefaultOpenRouterModel(templatesResponse.default_openrouter_model?.trim() || "");
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
    () => runs.filter((run) => isActiveRun(run)),
    [runs],
  );
  const historyRuns = useMemo(
    () => runs.filter((run) => !isActiveRun(run)),
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
          <NewCapture
            minuteTemplates={minuteTemplates}
            defaultMinuteProvider={defaultMinuteProvider}
            defaultOpenRouterModel={defaultOpenRouterModel}
            onCreated={handleCreated}
          />
          <OverviewPanel
            health={health}
            connectionState={connectionState}
            activeCount={activeRuns.length}
            totalCount={runs.length}
          />
        </aside>

        <section className="main-column">
          <LiveRuns
            runs={activeRuns}
            onStopRun={handleStopRun}
            onMinutesChanged={queueRunRefresh}
          />
          <HistoryTable runs={historyRuns} onMinutesChanged={queueRunRefresh} />
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
