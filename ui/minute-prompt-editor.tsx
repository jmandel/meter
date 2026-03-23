import { useEffect, useRef } from "react";

import type { MinutePromptTemplate } from "../src/minute-prompts";
import {
  MINUTE_CLAUDE_EFFORT_OPTIONS,
  MINUTE_CLAUDE_MODEL_SUGGESTIONS,
  MINUTE_OPENROUTER_MODEL_SUGGESTIONS,
  type MinutePresetSource,
  type UiMinuteClaudeEffort,
} from "./minute-prompt-core";

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

export function MinutePromptEditor({
  templates,
  minuteDraft,
  disabled = false,
  includeRunSource = false,
}: {
  templates: MinutePromptTemplate[];
  minuteDraft: {
    presets: Array<{ name: string }>;
    selectedSource: MinutePresetSource;
    selectedPresetName: string | null;
    selectedLabel: string;
    selectedTemplate: MinutePromptTemplate | null;
    provider: "claude_tmux" | "openrouter_patch";
    promptBody: string;
    claudeModel: string;
    claudeEffort: UiMinuteClaudeEffort;
    openrouterModel: string;
    hasUnsavedChanges: boolean;
    presetNameDraft: string;
    presetError: string | null;
    presetMutationState: "idle" | "saving" | "deleting";
    selectSource: (source: MinutePresetSource) => void;
    setPromptBody: (nextValue: string) => void;
    setClaudeModel: (nextValue: string) => void;
    setClaudeEffort: (nextValue: UiMinuteClaudeEffort) => void;
    setOpenRouterModel: (nextValue: string) => void;
    setPresetNameDraft: (nextValue: string) => void;
    savePreset: () => Promise<void>;
    deleteSelectedPreset: () => Promise<void>;
    resetDraftToSelected: () => void;
  };
}) {
  const isMutating = minuteDraft.presetMutationState !== "idle";

  return (
    <div className="minutes-controls">
      <div className="minutes-preset-row">
        <label className="field minutes-preset-picker">
          <span>Prompt preset</span>
          <select
            value={minuteDraft.selectedSource}
            disabled={disabled || isMutating}
            onChange={(event) => minuteDraft.selectSource(event.target.value as MinutePresetSource)}
          >
            {includeRunSource ? <option value="run">This run&apos;s saved settings</option> : null}
            <option value="recent">Most recent (browser only)</option>
            {templates.map((template) => (
              <option key={template.template_id} value={`template:${template.template_id}`}>
                Template: {template.name}
              </option>
            ))}
            {minuteDraft.presets.map((preset) => (
              <option key={preset.name} value={`preset:${preset.name}`}>
                Saved: {preset.name}
              </option>
            ))}
          </select>
        </label>
        <span className={`minutes-draft ${minuteDraft.hasUnsavedChanges ? "minutes-draft-dirty" : "minutes-draft-clean"}`}>
          {minuteDraft.hasUnsavedChanges ? "Unsaved changes" : `Using ${minuteDraft.selectedLabel}`}
        </span>
        {minuteDraft.selectedPresetName && !minuteDraft.hasUnsavedChanges ? (
          <button
            className="ghost-button"
            disabled={disabled || isMutating}
            onClick={() => void minuteDraft.deleteSelectedPreset()}
            type="button"
          >
            {minuteDraft.presetMutationState === "deleting" ? "Deleting…" : "Delete preset"}
          </button>
        ) : null}
      </div>
      <div className="minutes-preset-save">
        <label className="field minutes-preset-name">
          <span>Save to server as</span>
          <input
            type="text"
            placeholder="FHIR WG formal"
            value={minuteDraft.presetNameDraft}
            disabled={disabled || isMutating}
            onChange={(event) => minuteDraft.setPresetNameDraft(event.target.value)}
          />
        </label>
        <div className="minutes-preset-actions">
          <button
            className="secondary-button"
            disabled={disabled || isMutating}
            onClick={() => void minuteDraft.savePreset()}
            type="button"
          >
            {minuteDraft.presetMutationState === "saving" ? "Saving…" : "Save preset"}
          </button>
          <button
            className="ghost-button"
            disabled={disabled || isMutating || !minuteDraft.hasUnsavedChanges}
            onClick={minuteDraft.resetDraftToSelected}
            type="button"
          >
            Revert draft
          </button>
        </div>
      </div>
      {minuteDraft.presetError ? <div className="inline-error">{minuteDraft.presetError}</div> : null}
      {minuteDraft.selectedTemplate ? (
        <p className="field-hint">{minuteDraft.selectedTemplate.description}</p>
      ) : null}
      <label className="field">
        <span>Minute prompt</span>
        <AutoGrowTextarea
          className="auto-grow-textarea"
          disabled={disabled || isMutating}
          value={minuteDraft.promptBody}
          onChange={minuteDraft.setPromptBody}
        />
      </label>
      {minuteDraft.provider === "claude_tmux" ? (
        <div className="minutes-config-grid">
          <label className="field">
            <span>Claude model</span>
            <select
              value={minuteDraft.claudeModel}
              disabled={disabled || isMutating}
              onChange={(event) => minuteDraft.setClaudeModel(event.target.value)}
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
              disabled={disabled || isMutating}
              onChange={(event) => minuteDraft.setClaudeEffort(event.target.value as UiMinuteClaudeEffort)}
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
              disabled={disabled || isMutating}
              onChange={(event) => minuteDraft.setOpenRouterModel(event.target.value)}
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
    </div>
  );
}
