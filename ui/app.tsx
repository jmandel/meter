import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

import { DEFAULT_MINUTE_FINAL_PROMPT_BODY, DEFAULT_MINUTE_PROMPT_BODY } from "../src/minute-prompts";
import {
  appendTranscriptEvent,
  buildTranscriptPreview,
  normalizeTranscriptSpeaker,
  transcriptEntryText,
  type SpeechSegmentRecord,
  type TranscriptEntry,
} from "./transcript";

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
  tmux_session_name: string | null;
  prompt_label: string | null;
  prompt_hash: string | null;
  user_prompt_body: string | null;
  user_final_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: "low" | "medium" | "high" | "max" | null;
  latest_version_seq: number;
  started_at: string;
  ended_at: string | null;
  last_update_at: string | null;
}

interface MinuteVersionRecord {
  minute_version_id: string;
  seq: number;
  status: "live" | "final";
  created_at: string;
}

interface MinuteStreamMessage {
  minute_job: MinuteJobRecord;
  version: MinuteVersionRecord;
  content_markdown: string;
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
const MINUTE_LOCAL_DEFAULTS_STORAGE_BASE = "meter:minutes:local-default";
const MINUTE_LOCAL_PRESETS_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:presets`;
const MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:selected`;
const MINUTE_CLAUDE_EFFORT_OPTIONS = ["", "low", "medium", "high", "max"] as const;

type UiMinuteClaudeEffort = (typeof MINUTE_CLAUDE_EFFORT_OPTIONS)[number];
type MinutePresetSource = "default" | "run" | `preset:${string}`;

interface MinuteDraftFields {
  promptBody: string;
  finalPromptBody: string;
  claudeModel: string;
  claudeEffort: UiMinuteClaudeEffort;
}

interface LocalMinutePreset extends MinuteDraftFields {
  name: string;
}

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

function renderMinutesMarkdown(markdown: string): string {
  return marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
}

function effectiveMinutePromptBody(value: string | null | undefined): string {
  return value?.trim() ? value : DEFAULT_MINUTE_PROMPT_BODY;
}

function effectiveMinuteFinalPromptBody(value: string | null | undefined): string {
  return value?.trim() ? value : DEFAULT_MINUTE_FINAL_PROMPT_BODY;
}

function normalizeMinuteClaudeModel(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeMinuteClaudeEffort(value: string | null | undefined): UiMinuteClaudeEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "";
}

function serializeMinutePromptBody(value: string, fallback: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === fallback.trim()) {
    return null;
  }
  return trimmed;
}

function serializeMinuteClaudeModel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function serializeMinuteClaudeEffort(value: UiMinuteClaudeEffort): "low" | "medium" | "high" | "max" | null {
  return value || null;
}

function legacyMinuteLocalDefaultsStorageKey(kind: "prompt" | "final" | "model" | "effort"): string {
  return `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:${kind}`;
}

function defaultMinuteDraftFields(): MinuteDraftFields {
  return {
    promptBody: DEFAULT_MINUTE_PROMPT_BODY,
    finalPromptBody: DEFAULT_MINUTE_FINAL_PROMPT_BODY,
    claudeModel: "",
    claudeEffort: "",
  };
}

function normalizeMinuteDraftFields(fields: MinuteDraftFields): MinuteDraftFields {
  return {
    promptBody: effectiveMinutePromptBody(fields.promptBody),
    finalPromptBody: effectiveMinuteFinalPromptBody(fields.finalPromptBody),
    claudeModel: normalizeMinuteClaudeModel(fields.claudeModel),
    claudeEffort: normalizeMinuteClaudeEffort(fields.claudeEffort),
  };
}

function minuteDraftFieldsEqual(left: MinuteDraftFields, right: MinuteDraftFields): boolean {
  return left.promptBody === right.promptBody
    && left.finalPromptBody === right.finalPromptBody
    && left.claudeModel === right.claudeModel
    && left.claudeEffort === right.claudeEffort;
}

function minutePresetSourceForName(name: string): MinutePresetSource {
  return `preset:${name}`;
}

function minutePresetNameFromSource(source: MinutePresetSource): string | null {
  return source.startsWith("preset:") ? source.slice("preset:".length) : null;
}

function sortMinutePresets(presets: LocalMinutePreset[]): LocalMinutePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function normalizeLocalMinutePreset(input: unknown): LocalMinutePreset | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<Record<string, unknown>>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) {
    return null;
  }
  const normalized = normalizeMinuteDraftFields({
    promptBody: typeof candidate.promptBody === "string" ? candidate.promptBody : DEFAULT_MINUTE_PROMPT_BODY,
    finalPromptBody: typeof candidate.finalPromptBody === "string" ? candidate.finalPromptBody : DEFAULT_MINUTE_FINAL_PROMPT_BODY,
    claudeModel: typeof candidate.claudeModel === "string" ? candidate.claudeModel : "",
    claudeEffort: typeof candidate.claudeEffort === "string" ? candidate.claudeEffort as UiMinuteClaudeEffort : "",
  });
  return {
    name,
    ...normalized,
  };
}

function buildUniqueMinutePresetName(existing: LocalMinutePreset[], baseName: string): string {
  const trimmedBase = baseName.trim() || "Local custom";
  const existingNames = new Set(existing.map((preset) => preset.name.toLowerCase()));
  if (!existingNames.has(trimmedBase.toLowerCase())) {
    return trimmedBase;
  }
  let index = 2;
  while (existingNames.has(`${trimmedBase} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${trimmedBase} ${index}`;
}

function writeStoredMinutePresets(presets: LocalMinutePreset[]): void {
  if (presets.length === 0) {
    window.localStorage.removeItem(MINUTE_LOCAL_PRESETS_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(MINUTE_LOCAL_PRESETS_STORAGE_KEY, JSON.stringify(sortMinutePresets(presets)));
}

function persistSelectedMinutePresetSource(source: MinutePresetSource): void {
  if (source === "default" || source === "run") {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY, source);
}

function migrateLegacyMinuteLocalDefaults(existingPresets: LocalMinutePreset[]): LocalMinutePreset[] {
  const legacyPrompt = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("prompt"));
  const legacyFinal = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("final"));
  const legacyModel = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("model"));
  const legacyEffort = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("effort"));

  const cleanupLegacy = () => {
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("prompt"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("final"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("model"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("effort"));
  };

  if (!legacyPrompt && !legacyFinal && !legacyModel && !legacyEffort) {
    return existingPresets;
  }

  const legacyPresetFields = normalizeMinuteDraftFields({
    promptBody: legacyPrompt ?? DEFAULT_MINUTE_PROMPT_BODY,
    finalPromptBody: legacyFinal ?? DEFAULT_MINUTE_FINAL_PROMPT_BODY,
    claudeModel: legacyModel ?? "",
    claudeEffort: normalizeMinuteClaudeEffort(legacyEffort),
  });

  cleanupLegacy();

  if (minuteDraftFieldsEqual(legacyPresetFields, defaultMinuteDraftFields())) {
    return existingPresets;
  }

  if (existingPresets.some((preset) => minuteDraftFieldsEqual(preset, legacyPresetFields))) {
    return existingPresets;
  }

  const migratedName = buildUniqueMinutePresetName(existingPresets, "Local custom");
  const nextPresets = sortMinutePresets([
    ...existingPresets,
    {
      name: migratedName,
      ...legacyPresetFields,
    },
  ]);
  writeStoredMinutePresets(nextPresets);
  persistSelectedMinutePresetSource(minutePresetSourceForName(migratedName));
  return nextPresets;
}

function readStoredMinutePresets(): LocalMinutePreset[] {
  const raw = window.localStorage.getItem(MINUTE_LOCAL_PRESETS_STORAGE_KEY);
  let presets: LocalMinutePreset[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const seenNames = new Set<string>();
        presets = parsed.flatMap((item) => {
          const preset = normalizeLocalMinutePreset(item);
          if (!preset) {
            return [];
          }
          const key = preset.name.toLowerCase();
          if (seenNames.has(key)) {
            return [];
          }
          seenNames.add(key);
          return [preset];
        });
      }
    } catch {
      window.localStorage.removeItem(MINUTE_LOCAL_PRESETS_STORAGE_KEY);
    }
  }
  return migrateLegacyMinuteLocalDefaults(sortMinutePresets(presets));
}

function readStoredMinutePresetSource(presets: LocalMinutePreset[]): MinutePresetSource {
  const stored = window.localStorage.getItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY)?.trim();
  if (!stored || stored === "default") {
    return "default";
  }
  const presetName = minutePresetNameFromSource(stored as MinutePresetSource);
  if (!presetName) {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
    return "default";
  }
  if (!presets.some((preset) => preset.name === presetName)) {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
    return "default";
  }
  return stored as MinutePresetSource;
}

function minuteDraftFieldsForSource(
  source: MinutePresetSource,
  presets: LocalMinutePreset[],
  runningFields: MinuteDraftFields | null,
): MinuteDraftFields {
  if (source === "run" && runningFields) {
    return normalizeMinuteDraftFields(runningFields);
  }
  const presetName = minutePresetNameFromSource(source);
  if (presetName) {
    const preset = presets.find((candidate) => candidate.name === presetName);
    if (preset) {
      return preset;
    }
  }
  return defaultMinuteDraftFields();
}

function minutePresetLabelForSource(source: MinutePresetSource): string {
  if (source === "default") {
    return "Meter default";
  }
  if (source === "run") {
    return "This run's saved settings";
  }
  return minutePresetNameFromSource(source) ?? "Local preset";
}

function isReservedMinutePresetName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "default"
    || normalized === "meter default"
    || normalized === "this run's saved settings";
}

function useMinutePresetDraftManager({
  runningFields,
  runningPromptLabel,
  preferRunningPreset,
}: {
  runningFields: MinuteDraftFields | null;
  runningPromptLabel: string | null;
  preferRunningPreset: boolean;
}) {
  const [presets, setPresets] = useState<LocalMinutePreset[]>([]);
  const [selectedSource, setSelectedSource] = useState<MinutePresetSource>("default");
  const [promptBody, setPromptBody] = useState(DEFAULT_MINUTE_PROMPT_BODY);
  const [finalPromptBody, setFinalPromptBody] = useState(DEFAULT_MINUTE_FINAL_PROMPT_BODY);
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState<UiMinuteClaudeEffort>("");
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);

  const normalizedRunningFields = useMemo(
    () => (runningFields ? normalizeMinuteDraftFields(runningFields) : null),
    [runningFields?.promptBody, runningFields?.finalPromptBody, runningFields?.claudeModel, runningFields?.claudeEffort],
  );

  useEffect(() => {
    const loadedPresets = readStoredMinutePresets();
    setPresets(loadedPresets);
    const storedSource = readStoredMinutePresetSource(loadedPresets);
    const nextSource = storedSource !== "default"
      ? storedSource
      : preferRunningPreset && normalizedRunningFields
        ? "run"
        : "default";
    const fields = minuteDraftFieldsForSource(nextSource, loadedPresets, normalizedRunningFields);
    setSelectedSource(nextSource);
    setPromptBody(fields.promptBody);
    setFinalPromptBody(fields.finalPromptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setPresetNameDraft(minutePresetNameFromSource(nextSource) ?? "");
    setPresetError(null);
  }, [
    normalizedRunningFields?.promptBody,
    normalizedRunningFields?.finalPromptBody,
    normalizedRunningFields?.claudeModel,
    normalizedRunningFields?.claudeEffort,
    preferRunningPreset,
  ]);

  const currentFields = useMemo(
    () => normalizeMinuteDraftFields({ promptBody, finalPromptBody, claudeModel, claudeEffort }),
    [promptBody, finalPromptBody, claudeModel, claudeEffort],
  );
  const selectedFields = useMemo(
    () => minuteDraftFieldsForSource(selectedSource, presets, normalizedRunningFields),
    [selectedSource, presets, normalizedRunningFields],
  );
  const hasUnsavedChanges = !minuteDraftFieldsEqual(currentFields, selectedFields);
  const selectedPresetName = minutePresetNameFromSource(selectedSource);
  const promptLabel = !hasUnsavedChanges
    ? selectedPresetName ?? (selectedSource === "run" ? runningPromptLabel : null)
    : null;

  const applySource = useCallback((source: MinutePresetSource, nextPresets = presets) => {
    const fields = minuteDraftFieldsForSource(source, nextPresets, normalizedRunningFields);
    setSelectedSource(source);
    setPromptBody(fields.promptBody);
    setFinalPromptBody(fields.finalPromptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setPresetNameDraft(minutePresetNameFromSource(source) ?? "");
    setPresetError(null);
    persistSelectedMinutePresetSource(source);
  }, [normalizedRunningFields, presets]);

  const selectSource = useCallback((source: MinutePresetSource) => {
    applySource(source);
  }, [applySource]);

  const savePreset = useCallback(() => {
    const trimmedName = presetNameDraft.trim();
    if (!trimmedName) {
      setPresetError("Name the preset before saving it.");
      return;
    }
    if (isReservedMinutePresetName(trimmedName)) {
      setPresetError("Choose a name other than Default or This run's saved settings.");
      return;
    }
    if (minuteDraftFieldsEqual(currentFields, defaultMinuteDraftFields())) {
      setPresetError("This matches Meter default. Use the default preset instead.");
      return;
    }
    const nextPreset: LocalMinutePreset = {
      name: trimmedName,
      ...currentFields,
    };
    const nextPresets = sortMinutePresets([
      ...presets.filter((preset) => preset.name.toLowerCase() !== trimmedName.toLowerCase()),
      nextPreset,
    ]);
    writeStoredMinutePresets(nextPresets);
    setPresets(nextPresets);
    applySource(minutePresetSourceForName(trimmedName), nextPresets);
  }, [applySource, currentFields, presetNameDraft, presets]);

  const deleteSelectedPreset = useCallback(() => {
    if (!selectedPresetName) {
      return;
    }
    const nextPresets = presets.filter((preset) => preset.name !== selectedPresetName);
    writeStoredMinutePresets(nextPresets);
    setPresets(nextPresets);
    applySource(normalizedRunningFields && preferRunningPreset ? "run" : "default", nextPresets);
  }, [applySource, normalizedRunningFields, preferRunningPreset, presets, selectedPresetName]);

  const resetDraftToSelected = useCallback(() => {
    const fields = minuteDraftFieldsForSource(selectedSource, presets, normalizedRunningFields);
    setPromptBody(fields.promptBody);
    setFinalPromptBody(fields.finalPromptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setPresetNameDraft(minutePresetNameFromSource(selectedSource) ?? "");
    setPresetError(null);
  }, [selectedSource, presets, normalizedRunningFields]);

  return {
    presets,
    selectedSource,
    selectedPresetName,
    selectedLabel: minutePresetLabelForSource(selectedSource),
    promptBody,
    finalPromptBody,
    claudeModel,
    claudeEffort,
    setPromptBody: (nextValue: string) => {
      setPromptBody(nextValue);
      setPresetError(null);
    },
    setFinalPromptBody: (nextValue: string) => {
      setFinalPromptBody(nextValue);
      setPresetError(null);
    },
    setClaudeModel: (nextValue: string) => {
      setClaudeModel(nextValue);
      setPresetError(null);
    },
    setClaudeEffort: (nextValue: UiMinuteClaudeEffort) => {
      setClaudeEffort(nextValue);
      setPresetError(null);
    },
    presetNameDraft,
    setPresetNameDraft,
    presetError,
    setPresetError,
    hasUnsavedChanges,
    promptLabel,
    selectSource,
    savePreset,
    deleteSelectedPreset,
    resetDraftToSelected,
  };
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

function speakerFromEvent(event: EventRecord): string | null {
  return normalizeTranscriptSpeaker(event.payload?.speaker_label ?? event.payload?.speaker_display_name ?? null);
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
    case "minutes.job.started":
      return {
        title: "Minutes started",
        detail: event.payload?.tmux_session_name ?? "Minute-taker running",
      };
    case "minutes.job.restarting":
      return {
        title: "Minutes restarted",
        detail: event.payload?.tmux_session_name ?? "Minute-taker restarting",
      };
    case "minutes.updated":
      return {
        title: "Minutes updated",
        detail: `Version ${event.payload?.version_seq ?? "?"}`,
      };
    case "minutes.job.failed":
      return {
        title: "Minutes failed",
        detail: event.payload?.code ? `Exit ${event.payload.code}` : "Minute-taker exited unexpectedly",
      };
    case "minutes.job.stopped":
      return {
        title: "Minutes stopped",
        detail: "Minute-taker stopped",
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
}: {
  onCreated: (run: MeetingRunRecord) => void;
}) {
  const enabledStorageKey = "meter:new-capture:minutes:enabled";
  const [joinUrl, setJoinUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [minutesEnabled, setMinutesEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minuteDraft = useMinutePresetDraftManager({
    runningFields: null,
    runningPromptLabel: null,
    preferRunningPreset: false,
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
          await postJson(`/v1/meeting-runs/${createdRun.meeting_run_id}/minutes/start`, {
            prompt_label: minuteDraft.promptLabel,
            user_prompt_body: serializeMinutePromptBody(minuteDraft.promptBody, DEFAULT_MINUTE_PROMPT_BODY),
            user_final_prompt_body: serializeMinutePromptBody(minuteDraft.finalPromptBody, DEFAULT_MINUTE_FINAL_PROMPT_BODY),
            claude_model: serializeMinuteClaudeModel(minuteDraft.claudeModel),
            claude_effort: serializeMinuteClaudeEffort(minuteDraft.claudeEffort),
          });
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
                  <option value="default">Meter default</option>
                  {minuteDraft.presets.map((preset) => (
                    <option key={preset.name} value={minutePresetSourceForName(preset.name)}>
                      {preset.name}
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
            <label className="field">
              <span>Minute prompt</span>
              <AutoGrowTextarea
                className="auto-grow-textarea"
                value={minuteDraft.promptBody}
                disabled={submitting}
                onChange={minuteDraft.setPromptBody}
              />
            </label>
            <label className="field">
              <span>Finalization prompt</span>
              <AutoGrowTextarea
                className="auto-grow-textarea"
                value={minuteDraft.finalPromptBody}
                disabled={submitting}
                onChange={minuteDraft.setFinalPromptBody}
              />
            </label>
            <div className="minutes-config-grid">
              <label className="field">
                <span>Claude model</span>
                <input
                  type="text"
                  placeholder="claude-sonnet-4-5"
                  value={minuteDraft.claudeModel}
                  disabled={submitting}
                  onChange={(inputEvent) => minuteDraft.setClaudeModel(inputEvent.target.value)}
                />
              </label>
              <label className="field">
                <span>Claude effort</span>
                <select
                  value={minuteDraft.claudeEffort}
                  disabled={submitting}
                  onChange={(inputEvent) => minuteDraft.setClaudeEffort(inputEvent.target.value as UiMinuteClaudeEffort)}
                >
                  <option value="">Server default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
              </label>
            </div>
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

function MinutesPanel({
  run,
  onChanged,
}: {
  run: MeetingRunRecord;
  onChanged: () => void;
}) {
  type MinuteStreamState = ConnectionState | "idle";
  const [content, setContent] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "starting" | "restarting" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<MinuteStreamState>("idle");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderedContent = useMemo(() => (content ? renderMinutesMarkdown(content) : ""), [content]);
  const minuteDraft = useMinutePresetDraftManager({
    runningFields: {
      promptBody: run.minutes?.user_prompt_body ?? DEFAULT_MINUTE_PROMPT_BODY,
      finalPromptBody: run.minutes?.user_final_prompt_body ?? DEFAULT_MINUTE_FINAL_PROMPT_BODY,
      claudeModel: run.minutes?.claude_model ?? "",
      claudeEffort: normalizeMinuteClaudeEffort(run.minutes?.claude_effort),
    },
    runningPromptLabel: run.minutes?.prompt_label ?? null,
    preferRunningPreset: Boolean(run.minutes),
  });

  useEffect(() => {
    let cancelled = false;
    const currentMinutes = run.minutes;
    if (!currentMinutes) {
      setContent("");
      setStreamState("idle");
      return;
    }

    setContent("");
    setStreamState("connecting");
    const eventSource = new EventSource(`/v1/meeting-runs/${run.meeting_run_id}/minutes/stream`);
    eventSource.onopen = () => {
      if (!cancelled) {
        setStreamState("live");
      }
    };
    eventSource.onerror = () => {
      if (!cancelled) {
        setStreamState("reconnecting");
      }
    };

    const handleMinutes = (message: MessageEvent) => {
      if (cancelled) {
        return;
      }
      const payload = JSON.parse(message.data) as MinuteStreamMessage;
      const viewport = contentRef.current;
      const wasNearBottom = viewport
        ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40
        : false;
      setContent(payload.content_markdown);
      if (viewport && wasNearBottom) {
        window.requestAnimationFrame(() => {
          viewport.scrollTop = viewport.scrollHeight;
        });
      }
      setStreamState("live");
    };

    eventSource.addEventListener("minutes", handleMinutes as EventListener);
    return () => {
      cancelled = true;
      eventSource.removeEventListener("minutes", handleMinutes as EventListener);
      eventSource.close();
    };
  }, [run.meeting_run_id, run.minutes?.minute_job_id]);

  const activeMinuteState = run.minutes?.state;
  const minutesRunning = activeMinuteState === "starting" || activeMinuteState === "running" || activeMinuteState === "stopping" || activeMinuteState === "restarting";
  const runningDraftFields = normalizeMinuteDraftFields({
    promptBody: run.minutes?.user_prompt_body ?? DEFAULT_MINUTE_PROMPT_BODY,
    finalPromptBody: run.minutes?.user_final_prompt_body ?? DEFAULT_MINUTE_FINAL_PROMPT_BODY,
    claudeModel: run.minutes?.claude_model ?? "",
    claudeEffort: normalizeMinuteClaudeEffort(run.minutes?.claude_effort),
  });
  const draftMatchesRunning = minuteDraftFieldsEqual(
    normalizeMinuteDraftFields({
      promptBody: minuteDraft.promptBody,
      finalPromptBody: minuteDraft.finalPromptBody,
      claudeModel: minuteDraft.claudeModel,
      claudeEffort: minuteDraft.claudeEffort,
    }),
    runningDraftFields,
  );
  const primaryAction = !run.minutes
    ? { action: "start" as const, label: "Start minutes", busyLabel: "Starting minutes..." }
    : minutesRunning
      ? { action: "restart" as const, label: "Restart minutes", busyLabel: "Restarting..." }
      : { action: "restart" as const, label: "Rerun minutes", busyLabel: "Restarting..." };

  const submit = async (action: "start" | "restart" | "stop") => {
    setError(null);
    setRequestState(action === "start" ? "starting" : action === "restart" ? "restarting" : "stopping");
    try {
      if (action === "stop") {
        await postJson(`/v1/meeting-runs/${run.meeting_run_id}/minutes/stop`, {});
      } else {
        await postJson(`/v1/meeting-runs/${run.meeting_run_id}/minutes/${action}`, {
          prompt_label: minuteDraft.promptLabel,
          user_prompt_body: serializeMinutePromptBody(minuteDraft.promptBody, DEFAULT_MINUTE_PROMPT_BODY),
          user_final_prompt_body: serializeMinutePromptBody(minuteDraft.finalPromptBody, DEFAULT_MINUTE_FINAL_PROMPT_BODY),
          claude_model: serializeMinuteClaudeModel(minuteDraft.claudeModel),
          claude_effort: serializeMinuteClaudeEffort(minuteDraft.claudeEffort),
        });
      }
      onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Failed to ${action} minutes`);
    } finally {
      setRequestState("idle");
    }
  };

  return (
    <div className="minutes-panel">
      <div className="minutes-head">
        <div className="transcript-heading">Live minutes</div>
        <div className="minutes-head-meta">
          <span className={`minutes-state minutes-state-${run.minutes?.state ?? "idle"}`}>
            {run.minutes?.state ?? "idle"}
          </span>
        </div>
      </div>

      <div className="minutes-controls">
        <div className="minutes-preset-row">
          <label className="minutes-field minutes-preset-picker">
            <span>Prompt preset</span>
            <select
              value={minuteDraft.selectedSource}
              onChange={(inputEvent) => minuteDraft.selectSource(inputEvent.target.value as MinutePresetSource)}
            >
              {run.minutes ? <option value="run">This run's saved settings</option> : null}
              <option value="default">Meter default</option>
              {minuteDraft.presets.map((preset) => (
                <option key={preset.name} value={minutePresetSourceForName(preset.name)}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <span className={`minutes-draft ${minuteDraft.hasUnsavedChanges ? "minutes-draft-dirty" : "minutes-draft-clean"}`}>
            {minuteDraft.hasUnsavedChanges ? "Unsaved local preset changes" : `Using ${minuteDraft.selectedLabel}`}
          </span>
          {minuteDraft.selectedPresetName && !minuteDraft.hasUnsavedChanges ? (
            <button className="ghost-button" disabled={requestState !== "idle"} onClick={minuteDraft.deleteSelectedPreset} type="button">
              Delete preset
            </button>
          ) : null}
        </div>
        {minuteDraft.hasUnsavedChanges ? (
          <div className="minutes-preset-save">
            <label className="minutes-field minutes-preset-name">
              <span>Save local preset as</span>
              <input
                type="text"
                placeholder="Weekly FHIR WG"
                value={minuteDraft.presetNameDraft}
                onChange={(inputEvent) => minuteDraft.setPresetNameDraft(inputEvent.target.value)}
              />
            </label>
            <div className="minutes-preset-actions">
              <button className="secondary-button" disabled={requestState !== "idle"} onClick={minuteDraft.savePreset} type="button">
                Save preset
              </button>
              <button className="ghost-button" disabled={requestState !== "idle"} onClick={minuteDraft.resetDraftToSelected} type="button">
                Revert draft
              </button>
            </div>
            {minuteDraft.presetError ? <div className="inline-error">{minuteDraft.presetError}</div> : null}
          </div>
        ) : null}
        <label className="minutes-field">
          <span>Minute prompt</span>
          <AutoGrowTextarea
            className="auto-grow-textarea"
            value={minuteDraft.promptBody}
            onChange={minuteDraft.setPromptBody}
          />
        </label>
        <label className="minutes-field">
          <span>Finalization prompt</span>
          <AutoGrowTextarea
            className="auto-grow-textarea"
            value={minuteDraft.finalPromptBody}
            onChange={minuteDraft.setFinalPromptBody}
          />
        </label>
        <div className="minutes-config-grid">
          <label className="minutes-field">
            <span>Claude model</span>
            <input
              type="text"
              placeholder="claude-sonnet-4-5"
              value={minuteDraft.claudeModel}
              onChange={(inputEvent) => minuteDraft.setClaudeModel(inputEvent.target.value)}
            />
          </label>
          <label className="minutes-field">
            <span>Claude effort</span>
            <select
              value={minuteDraft.claudeEffort}
              onChange={(inputEvent) => minuteDraft.setClaudeEffort(inputEvent.target.value as UiMinuteClaudeEffort)}
            >
              <option value="">Server default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="max">Max</option>
            </select>
          </label>
        </div>
        <div className="minutes-actions">
          {!minutesRunning ? (
            <button className="secondary-button" disabled={requestState !== "idle"} onClick={() => void submit(primaryAction.action)} type="button">
              {requestState === (primaryAction.action === "start" ? "starting" : "restarting") ? primaryAction.busyLabel : primaryAction.label}
            </button>
          ) : (
            <>
              <button className="secondary-button" disabled={requestState !== "idle"} onClick={() => void submit("restart")} type="button">
                {requestState === "restarting" ? "Restarting..." : "Restart minutes"}
              </button>
              <button className="ghost-button" disabled={requestState !== "idle"} onClick={() => void submit("stop")} type="button">
                {requestState === "stopping" ? "Stopping..." : "Stop minutes"}
              </button>
            </>
          )}
          {run.minutes ? (
            <a
              className="ghost-button action-link-button"
              href={`/v1/meeting-runs/${run.meeting_run_id}/minutes/view`}
              rel="noreferrer"
              target="_blank"
            >
              Open live view
            </a>
          ) : null}
          <span className={`minutes-draft ${draftMatchesRunning ? "minutes-draft-clean" : "minutes-draft-dirty"}`}>
            {draftMatchesRunning ? "Draft matches running prompt" : "Draft differs from running prompt"}
          </span>
        </div>
        <div className="minutes-meta-row">
          <span>Stream: {streamState === "live" ? "live" : streamState}</span>
          <span>Last update: {formatTime(run.minutes?.last_update_at ?? null)}</span>
          <span>Model: {run.minutes?.claude_model ?? "default"}</span>
          <span>Effort: {run.minutes?.claude_effort ?? "default"}</span>
          <span>TMUX: {run.minutes?.tmux_session_name ?? "--"}</span>
        </div>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="minutes-preview" ref={contentRef}>
        {content ? (
          <div className="minutes-markdown" dangerouslySetInnerHTML={{ __html: renderedContent }} />
        ) : (
          <div className="transcript-empty">
            {run.minutes ? "Waiting for rendered minutes." : "Minutes are off for this capture."}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveRunCard({
  run,
  transcript,
  onStopped,
  onMinutesChanged,
}: {
  run: MeetingRunRecord;
  transcript: TranscriptEntry[];
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

          <MinutesPanel run={run} onChanged={onMinutesChanged} />
        </div>
      </div>
    </article>
  );
}

function LiveRuns({
  runs,
  transcriptsByRun,
  onStopRun,
  onMinutesChanged,
}: {
  runs: MeetingRunRecord[];
  transcriptsByRun: Record<string, TranscriptEntry[]>;
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
              transcript={transcriptsByRun[run.meeting_run_id] ?? []}
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
  expanded,
  onToggleExpanded,
  onMinutesChanged,
}: {
  run: MeetingRunRecord;
  expanded: boolean;
  onToggleExpanded: () => void;
  onMinutesChanged: (meetingRunId: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          <div className="history-cell">
            <span>{formatRoomLabel(run.room_id)}</span>
            <small>Capture {shortId(run.meeting_run_id)}</small>
            <div className="history-actions">
              <a
                className="history-action"
                href={`/v1/meeting-runs/${run.meeting_run_id}/transcript.md`}
                rel="noreferrer"
                target="_blank"
              >
                Open transcript
              </a>
              {run.minutes ? (
                <a
                  className="history-action"
                  href={`/v1/meeting-runs/${run.meeting_run_id}/minutes/view`}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open minutes
                </a>
              ) : null}
              <button className="history-action history-button" onClick={onToggleExpanded} type="button">
                {expanded ? "Hide minute controls" : run.minutes ? "Rerun minutes" : "Start minutes"}
              </button>
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
      {expanded ? (
        <tr className="history-minutes-row">
          <td colSpan={8}>
            <MinutesPanel run={run} onChanged={() => onMinutesChanged(run.meeting_run_id)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function HistoryTable({
  runs,
  onMinutesChanged,
}: {
  runs: MeetingRunRecord[];
  onMinutesChanged: (meetingRunId: string) => void;
}) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

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
                  expanded={expandedRunId === run.meeting_run_id}
                  onToggleExpanded={() => setExpandedRunId((current) => current === run.meeting_run_id ? null : run.meeting_run_id)}
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

    if (isActiveRun(response.meeting_run)) {
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
        .filter((run) => isActiveRun(run))
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
          speaker_label: normalizeTranscriptSpeaker(payload.speaker_label) ?? activeSpeakerByRunRef.current[event.meeting_run_id] ?? null,
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
          <LiveRuns
            runs={activeRuns}
            transcriptsByRun={transcriptsByRun}
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
