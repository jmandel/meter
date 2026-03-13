import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_MINUTE_PROMPT_BODY,
  DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import { CURATED_OPENROUTER_MINUTE_MODELS } from "../src/minute-models";

const MINUTE_LOCAL_DEFAULTS_STORAGE_BASE = "meter:minutes:local-default";
const MINUTE_LOCAL_PRESETS_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:presets`;
const MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:selected`;

export const MINUTE_CLAUDE_EFFORT_OPTIONS = ["", "low", "medium", "high", "max"] as const;
export const MINUTE_CLAUDE_MODEL_SUGGESTIONS = [
  "opus",
  "sonnet",
  "haiku",
] as const;
export const MINUTE_OPENROUTER_MODEL_SUGGESTIONS = [
  ...CURATED_OPENROUTER_MINUTE_MODELS,
] as const;

export type UiMinuteClaudeEffort = (typeof MINUTE_CLAUDE_EFFORT_OPTIONS)[number];
export type UiMinuteProvider = "claude_tmux" | "openrouter_patch";
export type MinutePresetSource = "run" | `template:${string}` | `preset:${string}`;

export interface MinuteDraftFields {
  provider: UiMinuteProvider;
  promptTemplateId: string;
  promptBody: string;
  claudeModel: string;
  claudeEffort: UiMinuteClaudeEffort;
  openrouterModel: string;
}

export interface LocalMinutePreset extends MinuteDraftFields {
  name: string;
}

function minuteTemplateSource(templateId: string): MinutePresetSource {
  return `template:${templateId}`;
}

function minutePresetSourceForName(name: string): MinutePresetSource {
  return `preset:${name}`;
}

function minutePresetNameFromSource(source: MinutePresetSource): string | null {
  return source.startsWith("preset:") ? source.slice("preset:".length) : null;
}

function minuteTemplateIdFromSource(source: MinutePresetSource): string | null {
  return source.startsWith("template:") ? source.slice("template:".length) : null;
}

function normalizeMinuteClaudeModel(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeMinuteProvider(value: string | null | undefined, fallback: UiMinuteProvider): UiMinuteProvider {
  return value === "openrouter_patch" ? "openrouter_patch" : fallback;
}

function normalizeMinuteClaudeEffort(value: string | null | undefined): UiMinuteClaudeEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "";
}

function normalizeMinuteOpenRouterModel(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function getMinutePromptTemplateById(
  templates: MinutePromptTemplate[],
  templateId: string | null | undefined,
): MinutePromptTemplate | null {
  if (!templateId) {
    return null;
  }
  return templates.find((template) => template.template_id === templateId) ?? null;
}

function getTemplatePromptBody(
  templates: MinutePromptTemplate[],
  templateId: string | null | undefined,
): string {
  return getMinutePromptTemplateById(templates, templateId)?.prompt_body ?? DEFAULT_MINUTE_PROMPT_BODY;
}

function normalizeMinutePromptTemplateId(
  templates: MinutePromptTemplate[],
  templateId: string | null | undefined,
): string {
  return getMinutePromptTemplateById(templates, templateId)?.template_id ?? DEFAULT_MINUTE_PROMPT_TEMPLATE_ID;
}

export function defaultMinuteDraftFields(
  templates: MinutePromptTemplate[],
  defaultProvider: UiMinuteProvider = "claude_tmux",
  defaultOpenRouterModel = "",
): MinuteDraftFields {
  const promptTemplateId = normalizeMinutePromptTemplateId(templates, DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
  return {
    provider: defaultProvider,
    promptTemplateId,
    promptBody: getTemplatePromptBody(templates, promptTemplateId),
    claudeModel: "",
    claudeEffort: "",
    openrouterModel: defaultProvider === "openrouter_patch" ? defaultOpenRouterModel.trim() : "",
  };
}

export function normalizeMinuteDraftFields(
  templates: MinutePromptTemplate[],
  fields: MinuteDraftFields,
  defaultProvider: UiMinuteProvider = "claude_tmux",
): MinuteDraftFields {
  const provider = normalizeMinuteProvider(fields.provider, defaultProvider);
  const promptTemplateId = normalizeMinutePromptTemplateId(templates, fields.promptTemplateId);
  return {
    provider,
    promptTemplateId,
    promptBody: fields.promptBody?.trim() ? fields.promptBody : getTemplatePromptBody(templates, promptTemplateId),
    claudeModel: normalizeMinuteClaudeModel(fields.claudeModel),
    claudeEffort: normalizeMinuteClaudeEffort(fields.claudeEffort),
    openrouterModel: provider === "openrouter_patch" ? normalizeMinuteOpenRouterModel(fields.openrouterModel) : "",
  };
}

export function minuteDraftFieldsEqual(left: MinuteDraftFields, right: MinuteDraftFields): boolean {
  return left.provider === right.provider
    && left.promptTemplateId === right.promptTemplateId
    && left.promptBody === right.promptBody
    && left.claudeModel === right.claudeModel
    && left.claudeEffort === right.claudeEffort
    && left.openrouterModel === right.openrouterModel;
}

function sortMinutePresets(presets: LocalMinutePreset[]): LocalMinutePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function normalizeLocalMinutePreset(
  templates: MinutePromptTemplate[],
  input: unknown,
): LocalMinutePreset | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<Record<string, unknown>>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) {
    return null;
  }
  const normalized = normalizeMinuteDraftFields(templates, {
    provider: typeof candidate.provider === "string" ? candidate.provider as UiMinuteProvider : "claude_tmux",
    promptTemplateId: typeof candidate.promptTemplateId === "string" ? candidate.promptTemplateId : DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
    promptBody: typeof candidate.promptBody === "string" ? candidate.promptBody : DEFAULT_MINUTE_PROMPT_BODY,
    claudeModel: typeof candidate.claudeModel === "string" ? candidate.claudeModel : "",
    claudeEffort: typeof candidate.claudeEffort === "string" ? candidate.claudeEffort as UiMinuteClaudeEffort : "",
    openrouterModel: typeof candidate.openrouterModel === "string" ? candidate.openrouterModel : "",
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
  if (source === minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID)) {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY, source);
}

function legacyMinuteLocalDefaultsStorageKey(kind: "prompt" | "final" | "model" | "effort"): string {
  return `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:${kind}`;
}

function migrateLegacyMinuteLocalDefaults(
  templates: MinutePromptTemplate[],
  existingPresets: LocalMinutePreset[],
): LocalMinutePreset[] {
  const legacyPrompt = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("prompt"));
  const legacyModel = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("model"));
  const legacyEffort = window.localStorage.getItem(legacyMinuteLocalDefaultsStorageKey("effort"));
  const cleanupLegacy = () => {
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("prompt"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("final"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("model"));
    window.localStorage.removeItem(legacyMinuteLocalDefaultsStorageKey("effort"));
  };
  if (!legacyPrompt && !legacyModel && !legacyEffort) {
    return existingPresets;
  }

  const legacyPresetFields = normalizeMinuteDraftFields(templates, {
    provider: "claude_tmux",
    promptTemplateId: DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
    promptBody: legacyPrompt ?? DEFAULT_MINUTE_PROMPT_BODY,
    claudeModel: legacyModel ?? "",
    claudeEffort: normalizeMinuteClaudeEffort(legacyEffort),
    openrouterModel: "",
  });
  cleanupLegacy();

  if (minuteDraftFieldsEqual(legacyPresetFields, defaultMinuteDraftFields(templates))) {
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

function readStoredMinutePresets(templates: MinutePromptTemplate[]): LocalMinutePreset[] {
  const raw = window.localStorage.getItem(MINUTE_LOCAL_PRESETS_STORAGE_KEY);
  let presets: LocalMinutePreset[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const seenNames = new Set<string>();
        presets = parsed.flatMap((item) => {
          const preset = normalizeLocalMinutePreset(templates, item);
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
  return migrateLegacyMinuteLocalDefaults(templates, sortMinutePresets(presets));
}

function readStoredMinutePresetSource(templates: MinutePromptTemplate[], presets: LocalMinutePreset[]): MinutePresetSource {
  const stored = window.localStorage.getItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY)?.trim();
  if (!stored) {
    return minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
  }
  if (stored === "run") {
    return "run";
  }
  const presetName = minutePresetNameFromSource(stored as MinutePresetSource);
  if (presetName) {
    if (!presets.some((preset) => preset.name === presetName)) {
      window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
      return minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
    }
    return stored as MinutePresetSource;
  }
  const templateId = minuteTemplateIdFromSource(stored as MinutePresetSource);
  if (!templateId || !getMinutePromptTemplateById(templates, templateId)) {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_PRESET_STORAGE_KEY);
    return minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
  }
  return stored as MinutePresetSource;
}

function minuteDraftFieldsForSource(
  templates: MinutePromptTemplate[],
  source: MinutePresetSource,
  presets: LocalMinutePreset[],
  runningFields: MinuteDraftFields | null,
  defaultProvider: UiMinuteProvider,
  defaultOpenRouterModel: string,
): MinuteDraftFields {
  if (source === "run" && runningFields) {
    return normalizeMinuteDraftFields(templates, runningFields, defaultProvider);
  }
  const presetName = minutePresetNameFromSource(source);
  if (presetName) {
    const preset = presets.find((candidate) => candidate.name === presetName);
    if (preset) {
      return preset;
    }
  }
  const templateId = minuteTemplateIdFromSource(source) ?? DEFAULT_MINUTE_PROMPT_TEMPLATE_ID;
  return defaultMinuteDraftFields(templates, defaultProvider, defaultOpenRouterModel).promptTemplateId === templateId
    ? defaultMinuteDraftFields(templates, defaultProvider, defaultOpenRouterModel)
    : normalizeMinuteDraftFields(templates, {
      provider: defaultProvider,
      promptTemplateId: templateId,
      promptBody: getTemplatePromptBody(templates, templateId),
      claudeModel: "",
      claudeEffort: "",
      openrouterModel: defaultProvider === "openrouter_patch" ? defaultOpenRouterModel : "",
    }, defaultProvider);
}

function minuteSourceLabel(
  templates: MinutePromptTemplate[],
  source: MinutePresetSource,
  runningPromptLabel: string | null,
): string {
  if (source === "run") {
    return runningPromptLabel || "This run's saved settings";
  }
  const presetName = minutePresetNameFromSource(source);
  if (presetName) {
    return presetName;
  }
  const templateId = minuteTemplateIdFromSource(source);
  return getMinutePromptTemplateById(templates, templateId)?.name ?? "Meter default";
}

function isReservedMinutePresetName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "default"
    || normalized === "meter default"
    || normalized === "this run's saved settings";
}

export function serializeMinutePromptBody(value: string, fallback: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === fallback.trim()) {
    return null;
  }
  return trimmed;
}

export function serializeMinuteClaudeModel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function serializeMinuteClaudeEffort(value: UiMinuteClaudeEffort): "low" | "medium" | "high" | "max" | null {
  return value || null;
}

export function serializeMinuteOpenRouterModel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function minutePromptRequestBody(
  templates: MinutePromptTemplate[],
  fields: MinuteDraftFields,
  promptLabel: string | null,
  defaultProvider: UiMinuteProvider = "claude_tmux",
): {
  provider: UiMinuteProvider | null;
  prompt_template_id: string;
  prompt_label: string | null;
  user_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: "low" | "medium" | "high" | "max" | null;
  openrouter_model: string | null;
} {
  const normalized = normalizeMinuteDraftFields(templates, fields, defaultProvider);
  const fallbackPrompt = getTemplatePromptBody(templates, normalized.promptTemplateId);
  return {
    provider: normalized.provider === defaultProvider ? null : normalized.provider,
    prompt_template_id: normalized.promptTemplateId,
    prompt_label: promptLabel,
    user_prompt_body: serializeMinutePromptBody(normalized.promptBody, fallbackPrompt),
    claude_model: normalized.provider === "claude_tmux" ? serializeMinuteClaudeModel(normalized.claudeModel) : null,
    claude_effort: normalized.provider === "claude_tmux" ? serializeMinuteClaudeEffort(normalized.claudeEffort) : null,
    openrouter_model: normalized.provider === "openrouter_patch" ? serializeMinuteOpenRouterModel(normalized.openrouterModel) : null,
  };
}

export function useMinutePresetDraftManager({
  templates,
  runningFields,
  runningPromptLabel,
  preferRunningPreset,
  defaultProvider = "claude_tmux",
  defaultOpenRouterModel = "",
}: {
  templates: MinutePromptTemplate[];
  runningFields: MinuteDraftFields | null;
  runningPromptLabel: string | null;
  preferRunningPreset: boolean;
  defaultProvider?: UiMinuteProvider;
  defaultOpenRouterModel?: string;
}) {
  const [presets, setPresets] = useState<LocalMinutePreset[]>([]);
  const [selectedSource, setSelectedSource] = useState<MinutePresetSource>(minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID));
  const [provider, setProvider] = useState<UiMinuteProvider>(defaultProvider);
  const [promptTemplateId, setPromptTemplateId] = useState(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
  const [promptBody, setPromptBody] = useState(DEFAULT_MINUTE_PROMPT_BODY);
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState<UiMinuteClaudeEffort>("");
  const [openrouterModel, setOpenRouterModel] = useState(defaultOpenRouterModel);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);

  const normalizedRunningFields = useMemo(
    () => (runningFields ? normalizeMinuteDraftFields(templates, runningFields, defaultProvider) : null),
    [templates, runningFields, defaultProvider],
  );

  useEffect(() => {
    const loadedPresets = readStoredMinutePresets(templates);
    setPresets(loadedPresets);
    const storedSource = readStoredMinutePresetSource(templates, loadedPresets);
    const nextSource = storedSource !== minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID)
      ? storedSource
      : preferRunningPreset && normalizedRunningFields
        ? "run"
        : minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
    const fields = minuteDraftFieldsForSource(templates, nextSource, loadedPresets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel);
    setSelectedSource(nextSource);
    setProvider(fields.provider);
    setPromptTemplateId(fields.promptTemplateId);
    setPromptBody(fields.promptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setOpenRouterModel(fields.openrouterModel);
    setPresetNameDraft(minutePresetNameFromSource(nextSource) ?? "");
    setPresetError(null);
  }, [templates, normalizedRunningFields, preferRunningPreset, defaultProvider, defaultOpenRouterModel]);

  const currentFields = useMemo(
    () => normalizeMinuteDraftFields(templates, { provider, promptTemplateId, promptBody, claudeModel, claudeEffort, openrouterModel }, defaultProvider),
    [templates, provider, promptTemplateId, promptBody, claudeModel, claudeEffort, openrouterModel, defaultProvider],
  );
  const selectedFields = useMemo(
    () => minuteDraftFieldsForSource(templates, selectedSource, presets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel),
    [templates, selectedSource, presets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel],
  );
  const hasUnsavedChanges = !minuteDraftFieldsEqual(currentFields, selectedFields);
  const selectedPresetName = minutePresetNameFromSource(selectedSource);
  const selectedTemplateId = currentFields.promptTemplateId;
  const selectedTemplate = getMinutePromptTemplateById(templates, selectedTemplateId);
  const promptLabel = !hasUnsavedChanges
    ? selectedPresetName ?? (selectedSource === "run" ? runningPromptLabel : null)
    : null;

  const applySource = useCallback((source: MinutePresetSource, nextPresets = presets) => {
    const fields = minuteDraftFieldsForSource(templates, source, nextPresets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel);
    setSelectedSource(source);
    setProvider(fields.provider);
    setPromptTemplateId(fields.promptTemplateId);
    setPromptBody(fields.promptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setOpenRouterModel(fields.openrouterModel);
    setPresetNameDraft(minutePresetNameFromSource(source) ?? "");
    setPresetError(null);
    persistSelectedMinutePresetSource(source);
  }, [templates, presets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel]);

  const selectSource = useCallback((source: MinutePresetSource) => {
    applySource(source);
  }, [applySource]);

  const selectTemplate = useCallback((templateId: string) => {
    applySource(minuteTemplateSource(templateId));
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
    if (minuteDraftFieldsEqual(currentFields, defaultMinuteDraftFields(templates, defaultProvider, defaultOpenRouterModel))) {
      setPresetError("This matches Meter default. Use a built-in template instead.");
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
  }, [applySource, currentFields, presetNameDraft, presets, templates, defaultProvider, defaultOpenRouterModel]);

  const deleteSelectedPreset = useCallback(() => {
    if (!selectedPresetName) {
      return;
    }
    const nextPresets = presets.filter((preset) => preset.name !== selectedPresetName);
    writeStoredMinutePresets(nextPresets);
    setPresets(nextPresets);
    applySource(normalizedRunningFields && preferRunningPreset ? "run" : minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID), nextPresets);
  }, [applySource, normalizedRunningFields, preferRunningPreset, presets, selectedPresetName]);

  const resetDraftToSelected = useCallback(() => {
    const fields = minuteDraftFieldsForSource(templates, selectedSource, presets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel);
    setProvider(fields.provider);
    setPromptTemplateId(fields.promptTemplateId);
    setPromptBody(fields.promptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setOpenRouterModel(fields.openrouterModel);
    setPresetNameDraft(minutePresetNameFromSource(selectedSource) ?? "");
    setPresetError(null);
  }, [templates, selectedSource, presets, normalizedRunningFields, defaultProvider, defaultOpenRouterModel]);

  return {
    presets,
    selectedSource,
    selectedPresetName,
    selectedLabel: minuteSourceLabel(templates, selectedSource, runningPromptLabel),
    selectedTemplateId,
    selectedTemplate,
    provider,
    promptBody,
    claudeModel,
    claudeEffort,
    openrouterModel,
    setProvider: (nextValue: UiMinuteProvider) => {
      setProvider(nextValue);
      setPresetError(null);
    },
    setPromptBody: (nextValue: string) => {
      setPromptBody(nextValue);
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
    setOpenRouterModel: (nextValue: string) => {
      setOpenRouterModel(nextValue);
      setPresetError(null);
    },
    selectSource,
    selectTemplate,
    presetNameDraft,
    setPresetNameDraft,
    presetError,
    hasUnsavedChanges,
    promptLabel,
    savePreset,
    deleteSelectedPreset,
    resetDraftToSelected,
    currentFields,
  };
}
