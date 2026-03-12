import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

import { listMinutePromptTemplates, type MinutePromptTemplate } from "../src/minute-prompts";
import {
  MINUTE_CLAUDE_EFFORT_OPTIONS,
  MINUTE_CLAUDE_MODEL_SUGGESTIONS,
  type MinuteDraftFields,
  type MinutePresetSource,
  type UiMinuteClaudeEffort,
  minutePromptRequestBody,
  useMinutePresetDraftManager,
} from "./minute-prompt-drafts";

const styles = `
  :root {
    color-scheme: light;
    --bg: #f6efe4;
    --surface: rgba(255, 252, 247, 0.96);
    --surface-soft: rgba(255, 248, 239, 0.92);
    --border: rgba(69, 51, 33, 0.12);
    --text: #241c14;
    --muted: #6d5e4a;
    --accent: #a74b15;
    --good: #1f7a4d;
    --warn: #b06023;
    --highlight: rgba(255, 227, 163, 0.78);
    --shadow: 0 18px 42px rgba(91, 62, 25, 0.08);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background:
      radial-gradient(circle at top left, rgba(211, 106, 46, 0.16), transparent 30%),
      linear-gradient(180deg, #fbf6ee 0%, var(--bg) 100%);
    color: var(--text);
    font-family: "Instrument Sans", "Avenir Next", "Segoe UI", sans-serif;
  }

  button, input, textarea, select { font: inherit; }
  button { cursor: pointer; }

  .shell {
    max-width: 1360px;
    margin: 0 auto;
    padding: 28px 20px 56px;
  }

  .head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 18px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 11px;
    font-weight: 800;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.8rem, 3vw, 2.8rem);
    line-height: 0.96;
    letter-spacing: -0.05em;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
    margin-top: 10px;
  }

  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .action-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
    font-weight: 700;
  }

  .action-link:hover {
    text-decoration: underline;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 999px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #c8b8a0;
  }

  .status-live .status-dot { background: var(--good); }
  .status-reconnecting .status-dot { background: var(--warn); }

  .workspace {
    display: grid;
    gap: 18px;
    align-items: start;
  }

  .workspace.with-settings {
    grid-template-columns: minmax(340px, 420px) minmax(0, 1fr);
  }

  .workspace.viewer-only {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 18px;
    box-shadow: var(--shadow);
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 14px;
    position: sticky;
    top: 18px;
  }

  .controls-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }

  .controls-head .section-title {
    margin-bottom: 0;
  }

  .section-title {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
    font-weight: 800;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .field span {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    font-weight: 700;
  }

  .field input,
  .field textarea,
  .field select {
    width: 100%;
    border: 1px solid rgba(88, 69, 46, 0.18);
    background: rgba(255, 255, 255, 0.92);
    color: var(--text);
    border-radius: 12px;
    padding: 12px 13px;
    outline: none;
  }

  .field textarea {
    resize: none;
    overflow: hidden;
    min-height: 120px;
  }

  .field input:focus,
  .field textarea:focus,
  .field select:focus {
    border-color: rgba(211, 106, 46, 0.52);
    box-shadow: 0 0 0 4px rgba(211, 106, 46, 0.14);
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .button-row,
  .meta-row,
  .copy-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .primary-button,
  .secondary-button,
  .ghost-button {
    border-radius: 14px;
    padding: 11px 16px;
    font-weight: 700;
    border: 1px solid transparent;
    transition: transform 120ms ease, box-shadow 120ms ease;
  }

  .primary-button {
    background: linear-gradient(135deg, #d36a2e 0%, #a74b15 100%);
    color: white;
    box-shadow: 0 12px 24px rgba(167, 75, 21, 0.22);
  }

  .secondary-button {
    background: rgba(235, 221, 202, 0.95);
    color: #a74b15;
    border-color: rgba(211, 106, 46, 0.22);
  }

  .ghost-button {
    background: rgba(255, 255, 255, 0.72);
    color: var(--text);
    border-color: var(--border);
  }

  .primary-button:hover:not(:disabled),
  .secondary-button:hover:not(:disabled),
  .ghost-button:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .primary-button:disabled,
  .secondary-button:disabled,
  .ghost-button:disabled {
    opacity: 0.56;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 800;
  }

  .pill-idle,
  .pill-completed {
    background: rgba(36, 28, 20, 0.08);
    color: var(--text);
  }

  .pill-starting,
  .pill-restarting {
    background: rgba(211, 106, 46, 0.14);
    color: var(--accent);
  }

  .pill-running {
    background: rgba(31, 122, 77, 0.14);
    color: var(--good);
  }

  .pill-stopping {
    background: rgba(176, 96, 35, 0.16);
    color: var(--warn);
  }

  .pill-failed {
    background: rgba(162, 47, 47, 0.13);
    color: #a22f2f;
  }

  .inline-error {
    border: 1px solid rgba(162, 47, 47, 0.24);
    background: rgba(255, 232, 229, 0.95);
    color: #a22f2f;
    border-radius: 12px;
    padding: 12px 14px;
  }

  .viewer-shell {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .viewer-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .viewer-head h2 {
    margin: 4px 0 0;
    font-size: 24px;
    letter-spacing: -0.04em;
  }

  .viewer-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--muted);
    font-size: 13px;
  }

  .viewer {
    min-height: min(68vh, 720px);
    border-radius: 18px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.94);
    padding: 22px 24px;
    line-height: 1.65;
  }

  .viewer > :first-child,
  .viewer .minutes-markdown > :first-child {
    margin-top: 0;
  }

  .viewer .minutes-markdown > :last-child {
    margin-bottom: 0;
  }

  .viewer h1,
  .viewer h2,
  .viewer h3,
  .viewer h4 {
    color: #17130e;
    line-height: 1.2;
  }

  .viewer code {
    background: rgba(235, 221, 202, 0.8);
    padding: 2px 6px;
    border-radius: 6px;
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  }

  .viewer pre {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .viewer blockquote {
    margin-left: 0;
    padding-left: 14px;
    border-left: 3px solid rgba(211, 106, 46, 0.24);
    color: var(--muted);
  }

  .empty {
    color: var(--muted);
    border: 1px dashed rgba(69, 51, 33, 0.16);
    border-radius: 18px;
    padding: 28px;
    text-align: center;
    background: rgba(255, 255, 255, 0.54);
  }

  @keyframes highlight-fade {
    0% { background-color: var(--highlight); }
    100% { background-color: transparent; }
  }

  .diff-new {
    animation: highlight-fade 4s ease-out forwards;
    border-radius: 4px;
  }

  @media (max-width: 980px) {
    .workspace,
    .workspace.with-settings,
    .workspace.viewer-only {
      grid-template-columns: 1fr;
    }

    .controls {
      position: static;
    }

    .field-grid {
      grid-template-columns: 1fr;
    }

    .viewer {
      min-height: 48vh;
    }
  }
`;

type MinuteJobState = "idle" | "starting" | "running" | "stopping" | "restarting" | "completed" | "failed";
type MinuteClaudeEffort = "" | "low" | "medium" | "high" | "max";

type MinuteJobRecord = {
  minute_job_id: string;
  state: MinuteJobState;
  tmux_session_name: string | null;
  prompt_template_id: string | null;
  prompt_label: string | null;
  user_prompt_body: string | null;
  claude_model: string | null;
  claude_effort: Exclude<MinuteClaudeEffort, ""> | null;
  latest_version_seq: number;
  last_update_at: string | null;
};

type MinuteVersionRecord = {
  minute_version_id: string;
  seq: number;
  status: "live" | "final";
  created_at: string;
};

type MinuteDetailsResponse = {
  meeting_run_id: string;
  minute_job: MinuteJobRecord | null;
  latest_version: MinuteVersionRecord | null;
};

type MinutePromptTemplatesResponse = {
  items: MinutePromptTemplate[];
};

const BUILTIN_MINUTE_PROMPT_TEMPLATES = listMinutePromptTemplates();

type StreamPayload = {
  minute_job: MinuteJobRecord;
  version: MinuteVersionRecord;
  content_markdown: string;
};

type Paths = {
  detailsPath: string | null;
  startPath: string | null;
  restartPath: string | null;
  stopPath: string | null;
  streamPath: string;
  markdownPath: string;
  transcriptPath: string | null;
  title: string | null;
};

function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.appendChild(style);
}

function getPaths(): Paths {
  const search = new URLSearchParams(window.location.search);
  const streamPath = search.get("stream");
  const markdownPath = search.get("markdown");
  if (!streamPath || !markdownPath) {
    const current = `${window.location.pathname}${window.location.search}`;
    return {
      detailsPath: search.get("details"),
      startPath: search.get("start"),
      restartPath: search.get("restart"),
      stopPath: search.get("stop"),
      transcriptPath: search.get("transcript"),
      streamPath: current.replace(/\/view(\?.*)?$/, "/stream$1"),
      markdownPath: current.replace(/\/view(\?.*)?$/, ".md$1"),
      title: search.get("title"),
    };
  }
  return {
    detailsPath: search.get("details"),
    startPath: search.get("start"),
    restartPath: search.get("restart"),
    stopPath: search.get("stop"),
    transcriptPath: search.get("transcript"),
    streamPath,
    markdownPath,
    title: search.get("title"),
  };
}

function formatTime(value: string | null): string {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
}

function getLeafNodes(container: Element): string[] {
  const nodes: string[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;
  while (current) {
    const tagName = current.tagName;
    if (["P", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "PRE", "TD"].includes(tagName)) {
      const text = current.textContent?.trim();
      if (text) {
        nodes.push(text);
      }
    }
    current = walker.nextNode() as Element | null;
  }
  return nodes;
}

function renderMinutesMarkdown(markdown: string): string {
  return marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
}

function applyMarkdownHighlights(container: HTMLElement, previousLeafTexts: Set<string>): Set<string> {
  const nextLeafTexts = new Set(getLeafNodes(container));
  const candidates = container.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,td");
  for (const element of candidates) {
    const text = element.textContent?.trim();
    if (text && !previousLeafTexts.has(text)) {
      element.classList.add("diff-new");
    }
  }
  return nextLeafTexts;
}

function setStatusClass(root: HTMLElement | null, tone: "idle" | "live" | "reconnecting"): void {
  if (!root) {
    return;
  }
  root.className = `status status-${tone}`;
}

function isWindowNearBottom(): boolean {
  const doc = document.documentElement;
  return window.scrollY + window.innerHeight >= doc.scrollHeight - 48;
}

function scrollWindowToBottom(): void {
  window.requestAnimationFrame(() => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
    });
  });
}

function AutoGrowTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
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
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function App() {
  const paths = useMemo(() => getPaths(), []);
  const [minuteJob, setMinuteJob] = useState<MinuteJobRecord | null>(null);
  const [version, setVersion] = useState<MinuteVersionRecord | null>(null);
  const [minuteTemplates, setMinuteTemplates] = useState<MinutePromptTemplate[]>(BUILTIN_MINUTE_PROMPT_TEMPLATES);
  const [content, setContent] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "starting" | "restarting" | "stopping">("idle");
  const [streamState, setStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [statusLabel, setStatusLabel] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const [updatedLabel, setUpdatedLabel] = useState("Waiting for first minute snapshot…");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousLeafTextsRef = useRef(new Set<string>());
  const lastMarkdownRef = useRef("");
  const windowStickBottomRef = useRef(true);
  const runningFields = useMemo<MinuteDraftFields | null>(() => {
    if (!minuteJob) {
      return null;
    }
    return {
      promptTemplateId: minuteJob.prompt_template_id ?? BUILTIN_MINUTE_PROMPT_TEMPLATES[0]?.template_id ?? "formal-working-group-minutes",
      promptBody: minuteJob.user_prompt_body ?? "",
      claudeModel: minuteJob.claude_model ?? "",
      claudeEffort: minuteJob.claude_effort ?? "",
    };
  }, [minuteJob]);
  const minuteDraft = useMinutePresetDraftManager({
    templates: minuteTemplates,
    runningFields,
    runningPromptLabel: minuteJob?.prompt_label ?? null,
    preferRunningPreset: Boolean(minuteJob),
  });

  const renderedContent = useMemo(() => renderMinutesMarkdown(content), [content]);

  const loadDetails = async (forceDraftReset = false) => {
    if (!paths.detailsPath) {
      return;
    }
    const response = await fetch(paths.detailsPath, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load minute details (${response.status})`);
    }
    const payload = await response.json() as MinuteDetailsResponse;
    setMinuteJob(payload.minute_job);
    setVersion(payload.latest_version);
    if (forceDraftReset) {
      setSettingsOpen(!payload.minute_job);
    }
  };

  const loadTemplates = async () => {
    try {
      const response = await fetch("/v1/minute-prompt-templates", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = await response.json() as MinutePromptTemplatesResponse;
      if (payload.items.length > 0) {
        setMinuteTemplates(payload.items);
      }
    } catch {
      // keep builtin fallback
    }
  };

  const fetchLatestMarkdown = async (reason: "initial" | "poll") => {
    try {
      const response = await fetch(paths.markdownPath, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const markdown = await response.text();
      if (!markdown.trim() || markdown === lastMarkdownRef.current) {
        return;
      }
      const wasNearBottom = windowStickBottomRef.current || isWindowNearBottom();
      lastMarkdownRef.current = markdown;
      setContent(markdown);
      setUpdatedLabel(reason === "initial" ? `Loaded ${new Date().toLocaleString()}` : `Updated ${new Date().toLocaleString()} · polled raw markdown`);
      if (wasNearBottom) {
        scrollWindowToBottom();
      }
    } catch {
      // ignore; stream may still succeed
    }
  };

  useEffect(() => {
    injectStyles();
    if (paths.title) {
      document.title = `${paths.title} Minutes`;
    }
    void loadTemplates();
    void loadDetails(true).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load minute details");
    });
    void fetchLatestMarkdown("initial");
  }, []);

  useEffect(() => {
    const viewport = contentRef.current;
    if (!viewport) {
      return;
    }
    const nextLeafTexts = applyMarkdownHighlights(viewport, previousLeafTextsRef.current);
    previousLeafTextsRef.current = nextLeafTexts;
  }, [renderedContent]);

  useEffect(() => {
    const handleWindowScroll = () => {
      windowStickBottomRef.current = isWindowNearBottom();
    };
    handleWindowScroll();
    window.addEventListener("scroll", handleWindowScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleWindowScroll);
    };
  }, []);

  useEffect(() => {
    const pollTimer = window.setInterval(() => {
      void fetchLatestMarkdown("poll");
    }, 3000);

    const eventSource = new EventSource(paths.streamPath);
    eventSource.onopen = () => {
      setStreamState("live");
      setStatusLabel("Live");
    };
    eventSource.onerror = () => {
      setStreamState("reconnecting");
      setStatusLabel("Reconnecting");
    };
    eventSource.addEventListener("heartbeat", () => {
      setStreamState("live");
      setStatusLabel("Live");
    });
    eventSource.addEventListener("minutes", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StreamPayload;
      const wasNearBottom = windowStickBottomRef.current || isWindowNearBottom();
      setMinuteJob(payload.minute_job);
      setVersion(payload.version);
      setStreamState("live");
      setStatusLabel(payload.version.status === "final" ? "Finalized" : "Live");
      setUpdatedLabel(`Updated ${new Date(payload.version.created_at).toLocaleString()} · version ${payload.version.seq}`);
      if (payload.content_markdown !== lastMarkdownRef.current) {
        lastMarkdownRef.current = payload.content_markdown;
        setContent(payload.content_markdown);
        if (wasNearBottom) {
          scrollWindowToBottom();
        }
      }
    });

    return () => {
      window.clearInterval(pollTimer);
      eventSource.close();
    };
  }, [paths.streamPath]);

  const submit = async (action: "start" | "restart" | "stop") => {
    const endpoint = action === "start" ? paths.startPath : action === "restart" ? paths.restartPath : paths.stopPath;
    if (!endpoint) {
      return;
    }
    setError(null);
    setRequestState(action === "start" ? "starting" : action === "restart" ? "restarting" : "stopping");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "stop"
          ? {}
          : minutePromptRequestBody(minuteTemplates, minuteDraft.currentFields, minuteDraft.promptLabel)),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? `Failed to ${action} minutes`);
      }
      await loadDetails(true);
      await fetchLatestMarkdown("poll");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Failed to ${action} minutes`);
    } finally {
      setRequestState("idle");
    }
  };

  const copyTmuxCommand = async () => {
    if (!minuteJob?.tmux_session_name) {
      return;
    }
    const command = `tmux attach -t ${minuteJob.tmux_session_name}`;
    try {
      await navigator.clipboard.writeText(command);
      setCopyNotice("Copied tmux attach command");
      window.setTimeout(() => setCopyNotice(null), 1800);
    } catch {
      setCopyNotice("Clipboard copy failed");
      window.setTimeout(() => setCopyNotice(null), 1800);
    }
  };

  const currentState = minuteJob?.state ?? "idle";
  const primaryAction = minuteJob ? "restart" : "start";
  const primaryLabel = minuteJob ? "Restart minutes" : "Start minutes";
  const workspaceClassName = `workspace ${settingsOpen ? "with-settings" : "viewer-only"}`;
  const settingsToggleLabel = settingsOpen ? "Hide settings" : minuteJob ? "Minute settings" : "Configure minutes";

  return (
    <main className="shell">
      <header className="head">
        <div>
          <p className="eyebrow">Minutes Workspace</p>
          <h1>{paths.title ?? "Meter Minutes"}</h1>
          <div className="meta">
            <span>Minute state: <span className={`pill pill-${currentState}`}>{currentState}</span></span>
            <span>{version ? `Version ${version.seq}` : "No rendered version yet"}</span>
            <span>{minuteJob?.last_update_at ? `Last update ${formatTime(minuteJob.last_update_at)}` : "No updates yet"}</span>
          </div>
        </div>
        <div className="actions">
          {paths.transcriptPath ? (
            <a className="action-link" href={paths.transcriptPath} target="_blank" rel="noreferrer">Open transcript</a>
          ) : null}
          <a className="action-link" href={paths.markdownPath} target="_blank" rel="noreferrer">Open raw markdown</a>
          <button className="ghost-button" onClick={() => setSettingsOpen((open) => !open)} type="button">
            {settingsToggleLabel}
          </button>
          <button className="ghost-button" disabled={!minuteJob?.tmux_session_name} onClick={() => void copyTmuxCommand()} type="button">
            Copy tmux attach
          </button>
          <div className="status" ref={(node) => setStatusClass(node, streamState)}>
            <span className="status-dot"></span>
            <span>{statusLabel}</span>
          </div>
        </div>
      </header>

      <section className={workspaceClassName}>
        {settingsOpen ? (
        <aside className="panel controls">
          <div className="controls-head">
            <p className="section-title">Minute settings</p>
            <button className="ghost-button" onClick={() => setSettingsOpen(false)} type="button">
              Hide
            </button>
          </div>
          <label className="field">
            <span>Prompt preset</span>
            <select
              value={minuteDraft.selectedSource}
              onChange={(event) => minuteDraft.selectSource(event.target.value as MinutePresetSource)}
            >
              {minuteJob ? <option value="run">This run's saved settings</option> : null}
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
          <div className="meta-row">
            <span className={`pill pill-${currentState}`}>{currentState}</span>
            <span>{minuteDraft.hasUnsavedChanges ? "Unsaved local preset changes" : `Using ${minuteDraft.selectedLabel}`}</span>
            {minuteDraft.selectedPresetName && !minuteDraft.hasUnsavedChanges ? (
              <button className="ghost-button" onClick={minuteDraft.deleteSelectedPreset} type="button">
                Delete preset
              </button>
            ) : null}
          </div>
          {minuteDraft.hasUnsavedChanges ? (
            <div className="field">
              <span>Save local preset as</span>
              <div className="button-row">
                <input
                  type="text"
                  placeholder="FHIR WG formal"
                  value={minuteDraft.presetNameDraft}
                  onChange={(event) => minuteDraft.setPresetNameDraft(event.target.value)}
                />
                <button className="secondary-button" onClick={minuteDraft.savePreset} type="button">
                  Save preset
                </button>
                <button className="ghost-button" onClick={minuteDraft.resetDraftToSelected} type="button">
                  Revert draft
                </button>
              </div>
              {minuteDraft.presetError ? <div className="inline-error">{minuteDraft.presetError}</div> : null}
            </div>
          ) : null}
          {minuteDraft.selectedTemplate ? (
            <div className="meta-row">
              <span>{minuteDraft.selectedTemplate.description}</span>
            </div>
          ) : null}
          <label className="field">
            <span>Minute prompt</span>
            <AutoGrowTextarea value={minuteDraft.promptBody} onChange={minuteDraft.setPromptBody} />
          </label>
          <div className="field-grid">
            <label className="field">
              <span>Claude model</span>
              <select
                value={minuteDraft.claudeModel}
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
              <select value={minuteDraft.claudeEffort} onChange={(event) => minuteDraft.setClaudeEffort(event.target.value as UiMinuteClaudeEffort)}>
                <option value="">Server default</option>
                {MINUTE_CLAUDE_EFFORT_OPTIONS.filter((value) => value).map((value) => (
                  <option key={value} value={value}>{value[0].toUpperCase()}{value.slice(1)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <button className="primary-button" disabled={requestState !== "idle"} onClick={() => void submit(primaryAction)} type="button">
              {requestState === (primaryAction === "start" ? "starting" : "restarting")
                ? primaryAction === "start" ? "Starting…" : "Restarting…"
                : primaryLabel}
            </button>
            <button className="ghost-button" disabled={requestState !== "idle" || !minuteJob || !["starting", "running", "restarting", "stopping"].includes(currentState)} onClick={() => void submit("stop")} type="button">
              {requestState === "stopping" ? "Stopping…" : "Stop minutes"}
            </button>
          </div>
          <div className="meta-row">
            <span>{minuteJob?.claude_model ?? "default model"}</span>
            <span>{minuteJob?.claude_effort ?? "default effort"}</span>
          </div>
          <div className="copy-row">
            <span>TMUX: {minuteJob?.tmux_session_name ?? "--"}</span>
            {copyNotice ? <span>{copyNotice}</span> : null}
          </div>
          {error ? <div className="inline-error">{error}</div> : null}
        </aside>
        ) : null}

        <section className="panel viewer-shell">
          <div className="viewer-head">
            <div>
              <p className="eyebrow">Rendered minutes</p>
              <h2>{minuteJob ? "Live minutes" : "Minutes preview"}</h2>
            </div>
            <div className="viewer-meta">
              <span>{updatedLabel}</span>
            </div>
          </div>
          <div className="viewer" ref={contentRef}>
            {content ? (
              <div className="minutes-markdown" dangerouslySetInnerHTML={{ __html: renderedContent }} />
            ) : (
              <div className="empty">Waiting for minutes…</div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

injectStyles();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root");
}

createRoot(rootElement).render(<App />);
