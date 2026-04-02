import { useCallback, useEffect, useMemo, useState } from "react";

import type { MinutePromptPresetRecord } from "../src/domain";
import {
  DEFAULT_MINUTE_PROMPT_TEMPLATE_ID,
  type MinutePromptTemplate,
} from "../src/minute-prompts";
import {
  MINUTE_CLAUDE_EFFORT_OPTIONS,
  MINUTE_CLAUDE_MODEL_SUGGESTIONS,
  MINUTE_OPENROUTER_MODEL_SUGGESTIONS,
  defaultMinuteDraftFields,
  getMinutePromptTemplateById,
  getTemplatePromptBody,
  isReservedMinutePresetName,
  minuteDraftFieldsEqual,
  minuteDraftFieldsForSource,
  minutePresetNameFromSource,
  minutePresetSourceForName,
  minutePromptRequestBody,
  minuteSourceLabel,
  minuteTemplateSource,
  normalizeMinuteDraftFields,
  normalizeSavedPreset,
  serializeMinuteClaudeEffort,
  serializeMinuteClaudeModel,
  serializeMinuteOpenRouterModel,
  serializeMinutePromptBody,
  sortMinutePresets,
  type MinuteDraftFields,
  type MinutePresetSource,
  type SavedMinutePreset,
  type UiMinuteClaudeEffort,
  type UiMinuteProvider,
} from "./minute-prompt-core";
import {
  persistSelectedMinutePresetSource,
  readStoredMinutePresetSource,
  readStoredRecentDraft,
  writeStoredRecentDraft,
} from "./minute-prompt-storage";

export {
  MINUTE_CLAUDE_EFFORT_OPTIONS,
  MINUTE_CLAUDE_MODEL_SUGGESTIONS,
  MINUTE_OPENROUTER_MODEL_SUGGESTIONS,
  minutePromptRequestBody,
  serializeMinuteClaudeEffort,
  serializeMinuteClaudeModel,
  serializeMinuteOpenRouterModel,
  serializeMinutePromptBody,
  type MinuteDraftFields,
  type MinutePresetSource,
  type UiMinuteClaudeEffort,
  type UiMinuteProvider,
};

export function useMinutePresetDraftManager({
  templates,
  savedPresets,
  runningFields,
  runningPromptLabel,
  preferRunningPreset,
  defaultProvider = "claude_tmux",
  defaultOpenRouterModel = "",
  onSavePreset,
  onDeletePreset,
}: {
  templates: MinutePromptTemplate[];
  savedPresets: MinutePromptPresetRecord[];
  runningFields: MinuteDraftFields | null;
  runningPromptLabel: string | null;
  preferRunningPreset: boolean;
  defaultProvider?: UiMinuteProvider;
  defaultOpenRouterModel?: string;
  onSavePreset?: (input: { name: string; fields: MinuteDraftFields }) => Promise<MinutePromptPresetRecord>;
  onDeletePreset?: (name: string) => Promise<void>;
}) {
  const [presets, setPresets] = useState<SavedMinutePreset[]>([]);
  const [selectedSource, setSelectedSource] = useState<MinutePresetSource>(minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID));
  const [provider, setProvider] = useState<UiMinuteProvider>(defaultProvider);
  const [promptTemplateId, setPromptTemplateId] = useState(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID);
  const [promptBody, setPromptBody] = useState("");
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState<UiMinuteClaudeEffort>("");
  const [openrouterModel, setOpenRouterModel] = useState(defaultOpenRouterModel);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetMutationState, setPresetMutationState] = useState<"idle" | "saving" | "deleting">("idle");

  const normalizedRunningFields = useMemo(
    () => (runningFields ? normalizeMinuteDraftFields(templates, runningFields, defaultProvider) : null),
    [templates, runningFields, defaultProvider],
  );

  const normalizedSavedPresets = useMemo(
    () => sortMinutePresets(savedPresets.map((preset) => normalizeSavedPreset(templates, preset, defaultProvider))),
    [savedPresets, templates, defaultProvider],
  );

  const recentFields = useMemo(
    () => readStoredRecentDraft(templates, defaultProvider),
    [templates, defaultProvider],
  );

  useEffect(() => {
    setPresets(normalizedSavedPresets);
    const storedSource = readStoredMinutePresetSource(
      templates,
      normalizedSavedPresets,
      Boolean(normalizedRunningFields),
    );
    const nextSource = storedSource
      ?? (preferRunningPreset && normalizedRunningFields ? "run" : recentFields ? "recent" : minuteTemplateSource(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID));
    const fields = minuteDraftFieldsForSource(
      templates,
      nextSource,
      normalizedSavedPresets,
      normalizedRunningFields,
      recentFields,
      defaultProvider,
      defaultOpenRouterModel,
    );
    setSelectedSource(nextSource);
    setProvider(fields.provider);
    setPromptTemplateId(fields.promptTemplateId);
    setPromptBody(fields.promptBody);
    setClaudeModel(fields.claudeModel);
    setClaudeEffort(fields.claudeEffort);
    setOpenRouterModel(fields.openrouterModel);
    setPresetNameDraft(minutePresetNameFromSource(nextSource) ?? "");
    setPresetError(null);
    setPresetMutationState("idle");
  }, [
    templates,
    normalizedSavedPresets,
    normalizedRunningFields,
    preferRunningPreset,
    recentFields,
    defaultProvider,
    defaultOpenRouterModel,
  ]);

  const currentFields = useMemo(
    () => normalizeMinuteDraftFields(templates, { provider, promptTemplateId, promptBody, claudeModel, claudeEffort, openrouterModel }, defaultProvider),
    [templates, provider, promptTemplateId, promptBody, claudeModel, claudeEffort, openrouterModel, defaultProvider],
  );

  useEffect(() => {
    writeStoredRecentDraft(currentFields);
  }, [currentFields]);

  const selectedFields = useMemo(
    () => minuteDraftFieldsForSource(templates, selectedSource, presets, normalizedRunningFields, recentFields, defaultProvider, defaultOpenRouterModel),
    [templates, selectedSource, presets, normalizedRunningFields, recentFields, defaultProvider, defaultOpenRouterModel],
  );

  const hasUnsavedChanges = !minuteDraftFieldsEqual(currentFields, selectedFields);
  const selectedPresetName = minutePresetNameFromSource(selectedSource);
  const selectedTemplateId = currentFields.promptTemplateId;
  const selectedTemplate = getMinutePromptTemplateById(templates, selectedTemplateId);
  const promptLabel = !hasUnsavedChanges
    ? selectedPresetName ?? (selectedSource === "run" ? runningPromptLabel : null)
    : null;

  const applySource = useCallback((source: MinutePresetSource, nextPresets = presets) => {
    const fields = minuteDraftFieldsForSource(
      templates,
      source,
      nextPresets,
      normalizedRunningFields,
      readStoredRecentDraft(templates, defaultProvider),
      defaultProvider,
      defaultOpenRouterModel,
    );
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

  const savePreset = useCallback(async () => {
    if (!onSavePreset) {
      return;
    }
    const trimmedName = presetNameDraft.trim();
    if (!trimmedName) {
      setPresetError("Name the preset before saving it.");
      return;
    }
    if (isReservedMinutePresetName(trimmedName)) {
      setPresetError("Choose a different name.");
      return;
    }
    setPresetMutationState("saving");
    setPresetError(null);
    try {
      const saved = normalizeSavedPreset(
        templates,
        await onSavePreset({ name: trimmedName, fields: currentFields }),
        defaultProvider,
      );
      const nextPresets = sortMinutePresets([
        ...presets.filter((preset) => preset.name.toLowerCase() !== trimmedName.toLowerCase()),
        saved,
      ]);
      setPresets(nextPresets);
      applySource(minutePresetSourceForName(saved.name), nextPresets);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : "Failed to save preset");
    } finally {
      setPresetMutationState("idle");
    }
  }, [applySource, currentFields, defaultProvider, onSavePreset, presetNameDraft, presets, templates]);

  const deleteSelectedPreset = useCallback(async () => {
    if (!selectedPresetName || !onDeletePreset) {
      return;
    }
    setPresetMutationState("deleting");
    setPresetError(null);
    try {
      await onDeletePreset(selectedPresetName);
      const nextPresets = presets.filter((preset) => preset.name !== selectedPresetName);
      setPresets(nextPresets);
      applySource(normalizedRunningFields && preferRunningPreset ? "run" : "recent", nextPresets);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : "Failed to delete preset");
    } finally {
      setPresetMutationState("idle");
    }
  }, [applySource, normalizedRunningFields, onDeletePreset, preferRunningPreset, presets, selectedPresetName]);

  const resetDraftToSelected = useCallback(() => {
    const fields = minuteDraftFieldsForSource(
      templates,
      selectedSource,
      presets,
      normalizedRunningFields,
      readStoredRecentDraft(templates, defaultProvider),
      defaultProvider,
      defaultOpenRouterModel,
    );
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
    promptLabel,
    currentFields,
    hasUnsavedChanges,
    presetNameDraft,
    setPresetNameDraft,
    presetError,
    presetMutationState,
    selectSource: applySource,
    selectTemplate: (templateId: string) => applySource(minuteTemplateSource(templateId)),
    savePreset,
    deleteSelectedPreset,
    resetDraftToSelected,
  };
}
