import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptPage } from "./transcript-view";
import { MinutesPage } from "./minutes-view";
import { MinutePromptEditor } from "./minute-prompt-editor";
import { AuthProvider, AuthStatusControl, useAuthSession } from "./auth";
import {
  deleteJson,
  fetchJson,
  postJson,
  type EventRecord,
  type HealthResponse,
  type MeetingRunRecord,
  type MinuteJobRecord,
  type MinutePromptPresetRecord,
  type MinutePromptTemplatesResponse,
} from "./api";

import {
  listMinutePromptTemplates,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import {
  type UiMinuteProvider,
  minutePromptRequestBody,
  useMinutePresetDraftManager,
} from "./minute-prompt-drafts";

type ConnectionState = "connecting" | "live" | "reconnecting";

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

function extractZoomMeetingId(roomId: string): string | null {
  const [provider, providerRoomKey] = roomId.split(":", 2);
  if (provider === "zoom" && providerRoomKey) {
    return providerRoomKey;
  }
  return null;
}

function buildTranscriptViewHref(run: MeetingRunRecord): string {
  const zoomMeetingId = extractZoomMeetingId(run.room_id);
  if (zoomMeetingId && isActiveRun(run)) {
    return `/zoom-meetings/${encodeURIComponent(zoomMeetingId)}/transcript/view?meeting_run_id=${encodeURIComponent(run.meeting_run_id)}`;
  }
  return `/meeting-runs/${run.meeting_run_id}/transcript/view`;
}

function buildMinutesViewHref(run: MeetingRunRecord): string {
  const zoomMeetingId = extractZoomMeetingId(run.room_id);
  if (zoomMeetingId && isActiveRun(run)) {
    return `/zoom-meetings/${encodeURIComponent(zoomMeetingId)}/minutes/view?meeting_run_id=${encodeURIComponent(run.meeting_run_id)}`;
  }
  return `/meeting-runs/${run.meeting_run_id}/minutes/view`;
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

function canResumeRun(run: MeetingRunRecord): boolean {
  if (isActiveRun(run)) {
    return false;
  }
  if (!run.ended_at) {
    return false;
  }
  return Date.now() - Date.parse(run.ended_at) <= 2 * 60 * 60 * 1000;
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
  minuteTemplates,
  minutePresets,
  defaultMinuteProvider,
  defaultOpenRouterModel,
  csrfToken,
  isAdmin,
}: {
  onCreated: (run: MeetingRunRecord) => void;
  minuteTemplates: MinutePromptTemplate[];
  minutePresets: MinutePromptPresetRecord[];
  defaultMinuteProvider: UiMinuteProvider;
  defaultOpenRouterModel: string;
  csrfToken: string | null;
  isAdmin: boolean;
}) {
  const enabledStorageKey = "meter:new-capture:minutes:enabled";
  const [joinUrl, setJoinUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [minutesEnabled, setMinutesEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minuteDraft = useMinutePresetDraftManager({
    templates: minuteTemplates,
    savedPresets: minutePresets,
    runningFields: null,
    runningPromptLabel: null,
    preferRunningPreset: false,
    defaultProvider: defaultMinuteProvider,
    defaultOpenRouterModel,
    onSavePreset: async ({ name, fields }) => {
      const response = await postJson<{ preset: MinutePromptPresetRecord }>("/v1/minute-prompt-presets", {
        name,
        ...minutePromptRequestBody(minuteTemplates, fields, name, defaultMinuteProvider),
      }, {
        headers: { "x-meter-csrf": csrfToken ?? "" },
      });
      return response.preset;
    },
    onDeletePreset: async (name) => {
      await deleteJson(`/v1/minute-prompt-presets/${encodeURIComponent(name)}`, {
        headers: { "x-meter-csrf": csrfToken ?? "" },
      });
    },
  });

  useEffect(() => {
    setMinutesEnabled(window.localStorage.getItem(enabledStorageKey) === "1");
  }, [enabledStorageKey]);

  useEffect(() => {
    window.localStorage.setItem(enabledStorageKey, minutesEnabled ? "1" : "0");
  }, [enabledStorageKey, minutesEnabled]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!joinUrl.trim() || !isAdmin) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await postJson<{ meeting_run: MeetingRunRecord }>("/v1/meeting-runs", {
        join_url: joinUrl.trim(),
        bot_name: botName.trim() || undefined,
      }, {
        headers: { "x-meter-csrf": csrfToken ?? "" },
      });
      let createdRun = response.meeting_run;
      let minuteStartError: string | null = null;
      if (minutesEnabled) {
        try {
          await postJson(
            `/v1/meeting-runs/${createdRun.meeting_run_id}/minutes/start`,
            minutePromptRequestBody(minuteTemplates, minuteDraft.currentFields, minuteDraft.promptLabel, defaultMinuteProvider),
            {
              headers: { "x-meter-csrf": csrfToken ?? "" },
            },
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
            disabled={submitting || !isAdmin}
            onChange={(inputEvent) => setJoinUrl(inputEvent.target.value)}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            placeholder="Meeting Bot"
            value={botName}
            disabled={submitting || !isAdmin}
            onChange={(inputEvent) => setBotName(inputEvent.target.value)}
          />
        </label>
        <label className="field-toggle">
          <input
            checked={minutesEnabled}
            disabled={submitting || !isAdmin}
            onChange={(inputEvent) => setMinutesEnabled(inputEvent.target.checked)}
            type="checkbox"
          />
          <span>Start live minutes too</span>
        </label>
        {minutesEnabled ? (
          <>
            <MinutePromptEditor
              templates={minuteTemplates}
              minuteDraft={minuteDraft}
              disabled={submitting || !isAdmin}
            />
          </>
        ) : null}
        <p className="field-hint">Starts immediately. Paste a Zoom link and choose the name shown in the meeting.</p>
        {!isAdmin ? <div className="field-hint">Unlock admin mode to start or modify captures.</div> : null}
        {error ? <div className="inline-error">{error}</div> : null}
        <button className="primary-button" disabled={submitting || !joinUrl.trim() || !isAdmin} type="submit">
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
  isAdmin,
}: {
  run: MeetingRunRecord;
  onStopped: () => Promise<void>;
  onMinutesChanged: () => void;
  isAdmin: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStop = async () => {
    if (!isAdmin) {
      return;
    }
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
          disabled={!isAdmin || stopping || run.state === "stopping"}
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
                  href={buildTranscriptViewHref(run)}
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
                    href={buildMinutesViewHref(run)}
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
  isAdmin,
}: {
  runs: MeetingRunRecord[];
  onStopRun: (meetingRunId: string) => Promise<void>;
  onMinutesChanged: (meetingRunId: string) => void;
  isAdmin: boolean;
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
              isAdmin={isAdmin}
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
  onResumeRun,
  isAdmin,
}: {
  run: MeetingRunRecord;
  onMinutesChanged: (meetingRunId: string) => void;
  onResumeRun: (meetingRunId: string) => Promise<void>;
  isAdmin: boolean;
}) {
  const [resumeState, setResumeState] = useState<"idle" | "submitting">("idle");
  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResume = async () => {
    if (!isAdmin) {
      return;
    }
    setResumeState("submitting");
    setResumeError(null);
    try {
      await onResumeRun(run.meeting_run_id);
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : "Failed to resume capture");
    } finally {
      setResumeState("idle");
    }
  };

  return (
    <tr>
      <td>
        <div className="history-cell">
          <span>{formatRoomLabel(run.room_id)}</span>
          <small>Capture {shortId(run.meeting_run_id)}</small>
          <div className="history-actions">
            <a
              className="history-action"
              href={buildTranscriptViewHref(run)}
              rel="noreferrer"
              target="_blank"
            >
              Open transcript
            </a>
            <a
              className="history-action"
              href={buildMinutesViewHref(run)}
              rel="noreferrer"
              target="_blank"
            >
              {run.minutes ? "Open minute workspace" : "Start minutes"}
            </a>
          </div>
          {resumeError ? <small>{resumeError}</small> : null}
        </div>
      </td>
      <td>{run.bot_name}</td>
      <td>
        <div className="history-status-cell">
          <StateBadge state={run.state} />
          {canResumeRun(run) ? (
            <button
              className="history-action history-button"
              disabled={!isAdmin || resumeState !== "idle"}
              onClick={() => void handleResume()}
              type="button"
            >
              {resumeState === "submitting" ? "Resuming..." : "Resume"}
            </button>
          ) : null}
        </div>
      </td>
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
  onResumeRun,
  isAdmin,
}: {
  runs: MeetingRunRecord[];
  onMinutesChanged: (meetingRunId: string) => void;
  onResumeRun: (meetingRunId: string) => Promise<void>;
  isAdmin: boolean;
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
                  onResumeRun={onResumeRun}
                  isAdmin={isAdmin}
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

function DashboardPage() {
  const { isAdmin, csrfToken } = useAuthSession();
  const [runs, setRuns] = useState<MeetingRunRecord[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [minuteTemplates, setMinuteTemplates] = useState<MinutePromptTemplate[]>(BUILTIN_MINUTE_PROMPT_TEMPLATES);
  const [minutePresets, setMinutePresets] = useState<MinutePromptPresetRecord[]>([]);
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
    setMinutePresets(templatesResponse.saved_presets ?? []);
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
    await postJson(`/v1/meeting-runs/${meetingRunId}/stop`, {}, {
      headers: { "x-meter-csrf": csrfToken ?? "" },
    });
    queueRunRefresh(meetingRunId);
  };

  const handleResumeRun = async (meetingRunId: string) => {
    const response = await postJson<{ meeting_run: MeetingRunRecord }>(`/v1/meeting-runs/${meetingRunId}/resume`, {}, {
      headers: { "x-meter-csrf": csrfToken ?? "" },
    });
    setRuns((currentRuns) => mergeRun(currentRuns, response.meeting_run));
    queueRunRefresh(response.meeting_run.meeting_run_id);
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
        <AuthStatusControl />
      </header>

      {pageError ? <div className="banner-error">{pageError}</div> : null}

      <main className="page-layout">
        <aside className="sidebar">
          <NewCapture
            minuteTemplates={minuteTemplates}
            minutePresets={minutePresets}
            defaultMinuteProvider={defaultMinuteProvider}
            defaultOpenRouterModel={defaultOpenRouterModel}
            csrfToken={csrfToken}
            isAdmin={isAdmin}
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
            isAdmin={isAdmin}
          />
          <HistoryTable runs={historyRuns} onMinutesChanged={queueRunRefresh} onResumeRun={handleResumeRun} isAdmin={isAdmin} />
        </section>
      </main>
    </div>
  );
}

function AppRouter() {
  const pathname = window.location.pathname;
  if (
    pathname === "/transcript-view"
    || /^\/meeting-runs\/[^/]+\/transcript\/view$/.test(pathname)
    || /^\/zoom-meetings\/[^/]+\/transcript\/view$/.test(pathname)
  ) {
    return <TranscriptPage />;
  }
  if (
    pathname === "/minutes-view"
    || /^\/meeting-runs\/[^/]+\/minutes\/view$/.test(pathname)
    || /^\/zoom-meetings\/[^/]+\/minutes\/view$/.test(pathname)
  ) {
    return <MinutesPage />;
  }
  return <DashboardPage />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

createRoot(rootElement).render(
  <AuthProvider>
    <AppRouter />
  </AuthProvider>,
);
