import type { MinutePromptPresetRecord } from "../src/domain";
import {
  DEFAULT_MINUTE_PROMPT_BODY,
  DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import { CURATED_OPENROUTER_MINUTE_MODELS } from "../src/minute-models";

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
export type MinutePresetSource = "run" | "recent" | `template:${string}` | `preset:${string}`;

export interface MinuteDraftFields {
  provider: UiMinuteProvider;
  promptTemplateId: string;
  promptBody: string;
  claudeModel: string;
  claudeEffort: UiMinuteClaudeEffort;
  openrouterModel: string;
}

export interface SavedMinutePreset extends MinuteDraftFields {
  presetId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export function minuteTemplateSource(templateId: string): MinutePresetSource {
  return `template:${templateId}`;
}

export function minutePresetSourceForName(name: string): MinutePresetSource {
  return `preset:${name}`;
}

export function minutePresetNameFromSource(source: MinutePresetSource): string | null {
  return source.startsWith("preset:") ? source.slice("preset:".length) : null;
}

export function minuteTemplateIdFromSource(source: MinutePresetSource): string | null {
  return source.startsWith("template:") ? source.slice("template:".length) : null;
}

export function normalizeMinuteClaudeModel(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function normalizeMinuteProvider(value: string | null | undefined, fallback: UiMinuteProvider): UiMinuteProvider {
  return value === "openrouter_patch" ? "openrouter_patch" : fallback;
}

export function normalizeMinuteClaudeEffort(value: string | null | undefined): UiMinuteClaudeEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "";
}

export function normalizeMinuteOpenRouterModel(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function getMinutePromptTemplateById(
  templates: MinutePromptTemplate[],
  templateId: string | null | undefined,
): MinutePromptTemplate | null {
  if (!templateId) {
    return null;
  }
  return templates.find((template) => template.template_id === templateId) ?? null;
}

export function getTemplatePromptBody(
  templates: MinutePromptTemplate[],
  templateId: string | null | undefined,
): string {
  return getMinutePromptTemplateById(templates, templateId)?.prompt_body ?? DEFAULT_MINUTE_PROMPT_BODY;
}

export function normalizeMinutePromptTemplateId(
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

export function normalizeSavedPreset(
  templates: MinutePromptTemplate[],
  preset: MinutePromptPresetRecord,
  defaultProvider: UiMinuteProvider,
): SavedMinutePreset {
  const normalized = normalizeMinuteDraftFields(templates, {
    provider: preset.provider ?? defaultProvider,
    promptTemplateId: preset.prompt_template_id ?? DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
    promptBody: preset.user_prompt_body ?? getTemplatePromptBody(templates, preset.prompt_template_id),
    claudeModel: preset.claude_model ?? "",
    claudeEffort: preset.claude_effort ?? "",
    openrouterModel: preset.openrouter_model ?? "",
  }, defaultProvider);
  return {
    presetId: preset.preset_id,
    name: preset.name,
    createdAt: preset.created_at,
    updatedAt: preset.updated_at,
    ...normalized,
  };
}

export function sortMinutePresets(presets: SavedMinutePreset[]): SavedMinutePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export function isReservedMinutePresetName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "default"
    || normalized === "meter default"
    || normalized === "this run's saved settings"
    || normalized === "most recent";
}

export function sourceExists(
  templates: MinutePromptTemplate[],
  source: MinutePresetSource,
  presets: SavedMinutePreset[],
  hasRunningFields: boolean,
): boolean {
  if (source === "run") {
    return hasRunningFields;
  }
  if (source === "recent") {
    return true;
  }
  const presetName = minutePresetNameFromSource(source);
  if (presetName) {
    return presets.some((preset) => preset.name === presetName);
  }
  const templateId = minuteTemplateIdFromSource(source);
  return Boolean(templateId && getMinutePromptTemplateById(templates, templateId));
}

export function minuteDraftFieldsForSource(
  templates: MinutePromptTemplate[],
  source: MinutePresetSource,
  presets: SavedMinutePreset[],
  runningFields: MinuteDraftFields | null,
  recentFields: MinuteDraftFields | null,
  defaultProvider: UiMinuteProvider,
  defaultOpenRouterModel: string,
): MinuteDraftFields {
  if (source === "run" && runningFields) {
    return normalizeMinuteDraftFields(templates, runningFields, defaultProvider);
  }
  if (source === "recent" && recentFields) {
    return normalizeMinuteDraftFields(templates, recentFields, defaultProvider);
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

export function minuteSourceLabel(
  templates: MinutePromptTemplate[],
  source: MinutePresetSource,
  runningPromptLabel: string | null,
): string {
  if (source === "run") {
    return runningPromptLabel || "This run's saved settings";
  }
  if (source === "recent") {
    return "Most recent";
  }
  const presetName = minutePresetNameFromSource(source);
  if (presetName) {
    return presetName;
  }
  const templateId = minuteTemplateIdFromSource(source);
  return getMinutePromptTemplateById(templates, templateId)?.name ?? "Meter default";
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
  provider: UiMinuteProvider;
  prompt_template_id: string;
  prompt_label: string | null;
  user_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: "low" | "medium" | "high" | "max" | null;
  openrouter_model: string | null;
} {
  const normalized = normalizeMinuteDraftFields(templates, fields, defaultProvider);
  const fallbackPromptBody = getTemplatePromptBody(templates, normalized.promptTemplateId);

  return {
    provider: normalized.provider,
    prompt_template_id: normalized.promptTemplateId,
    prompt_label: promptLabel?.trim() || null,
    user_prompt_body: serializeMinutePromptBody(normalized.promptBody, fallbackPromptBody),
    claude_model: normalized.provider === "claude_tmux"
      ? serializeMinuteClaudeModel(normalized.claudeModel)
      : null,
    claude_effort: normalized.provider === "claude_tmux"
      ? serializeMinuteClaudeEffort(normalized.claudeEffort)
      : null,
    openrouter_model: normalized.provider === "openrouter_patch"
      ? serializeMinuteOpenRouterModel(normalized.openrouterModel)
      : null,
  };
}
