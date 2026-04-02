import {
  DEFAULT_MINUTE_PROMPT_BODY,
  DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import type {
  MinuteDraftFields,
  MinutePresetSource,
  SavedMinutePreset,
  UiMinuteClaudeEffort,
  UiMinuteProvider,
} from "./minute-prompt-core";
import {
  normalizeMinuteDraftFields,
  sourceExists,
} from "./minute-prompt-core";

const MINUTE_LOCAL_DEFAULTS_STORAGE_BASE = "meter:minutes:drafts";
const MINUTE_LOCAL_RECENT_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:recent`;
const MINUTE_LOCAL_SELECTED_SOURCE_STORAGE_KEY = `${MINUTE_LOCAL_DEFAULTS_STORAGE_BASE}:selected`;

export function readStoredRecentDraft(
  templates: MinutePromptTemplate[],
  defaultProvider: UiMinuteProvider,
): MinuteDraftFields | null {
  const raw = window.localStorage.getItem(MINUTE_LOCAL_RECENT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof MinuteDraftFields, unknown>>;
    return normalizeMinuteDraftFields(templates, {
      provider: typeof parsed.provider === "string" ? parsed.provider as UiMinuteProvider : defaultProvider,
      promptTemplateId: typeof parsed.promptTemplateId === "string" ? parsed.promptTemplateId : DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
      promptBody: typeof parsed.promptBody === "string" ? parsed.promptBody : DEFAULT_MINUTE_PROMPT_BODY,
      claudeModel: typeof parsed.claudeModel === "string" ? parsed.claudeModel : "",
      claudeEffort: typeof parsed.claudeEffort === "string" ? parsed.claudeEffort as UiMinuteClaudeEffort : "",
      openrouterModel: typeof parsed.openrouterModel === "string" ? parsed.openrouterModel : "",
    }, defaultProvider);
  } catch {
    window.localStorage.removeItem(MINUTE_LOCAL_RECENT_STORAGE_KEY);
    return null;
  }
}

export function writeStoredRecentDraft(fields: MinuteDraftFields): void {
  window.localStorage.setItem(MINUTE_LOCAL_RECENT_STORAGE_KEY, JSON.stringify(fields));
}

export function readStoredMinutePresetSource(
  templates: MinutePromptTemplate[],
  presets: SavedMinutePreset[],
  hasRunningFields: boolean,
): MinutePresetSource | null {
  const raw = window.localStorage.getItem(MINUTE_LOCAL_SELECTED_SOURCE_STORAGE_KEY)?.trim();
  if (!raw) {
    return null;
  }
  const source = raw as MinutePresetSource;
  if (!sourceExists(templates, source, presets, hasRunningFields)) {
    window.localStorage.removeItem(MINUTE_LOCAL_SELECTED_SOURCE_STORAGE_KEY);
    return null;
  }
  return source;
}

export function persistSelectedMinutePresetSource(source: MinutePresetSource): void {
  window.localStorage.setItem(MINUTE_LOCAL_SELECTED_SOURCE_STORAGE_KEY, source);
}
