import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

import { listMinutePromptTemplates, type MinutePromptTemplate } from "../src/minute-prompts";
import {
  deleteJson,
  postJson,
  type MinuteDetailsResponse,
  type MinuteJobRecord,
  type MinutePromptPresetRecord,
  type MinutePromptTemplatesResponse,
  type MinuteVersionRecord,
} from "./api";
import { AuthStatusControl, useAuthSession } from "./auth";
import { MinutePromptEditor } from "./minute-prompt-editor";
import {
  type MinuteDraftFields,
  type UiMinuteProvider,
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

  .admin-control {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 10px;
  }

  .admin-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
  }

  .admin-pill-live {
    background: rgba(31, 122, 77, 0.12);
    color: var(--good);
  }

  .admin-pill-locked {
    background: rgba(176, 96, 35, 0.14);
    color: var(--warn);
  }

  .admin-login {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
  }

  .admin-login input {
    min-width: 220px;
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
    justify-content: center;
    gap: 8px;
    border-radius: 999px;
    padding: 8px 12px;
    min-width: 132px;
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

  .minutes-controls {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .minutes-preset-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .minutes-preset-picker {
    min-width: min(280px, 100%);
  }

  .minutes-preset-save {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }

  .minutes-preset-name {
    flex: 1 1 280px;
  }

  .minutes-preset-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .minutes-draft {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
  }

  .minutes-draft-clean {
    background: rgba(31, 122, 77, 0.12);
    color: var(--good);
  }

  .minutes-draft-dirty {
    background: rgba(211, 106, 46, 0.14);
    color: var(--accent);
  }

  .minutes-config-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
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
  recoverPath: string | null;
  stopPath: string | null;
  streamPath: string;
  markdownPath: string;
  transcriptPath: string | null;
  title: string | null;
};

function getPaths(): Paths {
  const search = new URLSearchParams(window.location.search);
  const streamPath = search.get("stream");
  const markdownPath = search.get("markdown");
  if (!streamPath || !markdownPath) {
    const currentPath = window.location.pathname;
    const currentSearch = window.location.search;
    const current = `${currentPath}${currentSearch}`;
    const zoomMeetingMatch = currentPath.match(/^\/zoom-meetings\/([^/]+)\/minutes\/view$/);
    if (zoomMeetingMatch) {
      const meetingId = decodeURIComponent(zoomMeetingMatch[1] ?? "");
      const meetingRunId = search.get("meeting_run_id");
      return {
        detailsPath: `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/minutes${currentSearch}`,
        startPath: meetingRunId ? `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/start` : null,
        restartPath: meetingRunId ? `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/restart` : null,
        recoverPath: meetingRunId ? `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/recover` : null,
        stopPath: meetingRunId ? `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/stop` : null,
        transcriptPath: `/zoom-meetings/${encodeURIComponent(meetingId)}/transcript/view${currentSearch}`,
        streamPath: `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/minutes/stream${currentSearch}`,
        markdownPath: `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/minutes.md${currentSearch}`,
        title: search.get("title"),
      };
    }
    const meetingRunMatch = currentPath.match(/^\/meeting-runs\/([^/]+)\/minutes\/view$/);
    if (meetingRunMatch) {
      const meetingRunId = decodeURIComponent(meetingRunMatch[1] ?? "");
      return {
        detailsPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes${currentSearch}`,
        startPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/start`,
        restartPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/restart`,
        recoverPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/recover`,
        stopPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/stop`,
        transcriptPath: `/meeting-runs/${encodeURIComponent(meetingRunId)}/transcript/view${currentSearch}`,
        streamPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes/stream${currentSearch}`,
        markdownPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/minutes.md${currentSearch}`,
        title: search.get("title"),
      };
    }
    return {
      detailsPath: search.get("details"),
      startPath: search.get("start"),
      restartPath: search.get("restart"),
      recoverPath: search.get("recover"),
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
    recoverPath: search.get("recover"),
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

function describeMinuteBackend(minuteJob: MinuteJobRecord): string {
  if (minuteJob.provider === "openrouter_patch") {
    return minuteJob.openrouter_model ? `Model ${minuteJob.openrouter_model}` : "Server default model";
  }
  const parts: string[] = [];
  if (minuteJob.claude_model?.trim()) {
    parts.push(`Model ${minuteJob.claude_model.trim()}`);
  }
  if (minuteJob.claude_effort?.trim()) {
    parts.push(`Effort ${minuteJob.claude_effort.trim()}`);
  }
  return parts.join(" · ") || "Server default model";
}

function getMinuteUiState(minuteJob: MinuteJobRecord | null, version: MinuteVersionRecord | null): {
  statusLabel: string;
  title: string;
} {
  if (!minuteJob) {
    return {
      statusLabel: version ? "Completed" : "Idle",
      title: version ? "Completed minutes" : "Minutes preview",
    };
  }
  if (minuteJob.state === "completed") {
    return {
      statusLabel: "Completed",
      title: "Completed minutes",
    };
  }
  if (minuteJob.state === "failed") {
    return {
      statusLabel: "Failed",
      title: "Minutes",
    };
  }
  if (minuteJob.state === "stopping") {
    return {
      statusLabel: "Stopping",
      title: "Minutes",
    };
  }
  if (minuteJob.state === "starting" || minuteJob.state === "restarting") {
    return {
      statusLabel: minuteJob.state === "starting" ? "Starting" : "Restarting",
      title: "Minutes",
    };
  }
  return {
    statusLabel: version?.status === "final" ? "Finalized" : "Live",
    title: "Live minutes",
  };
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
    element.classList.remove("diff-new");
    const text = element.textContent?.trim();
    if (text && !previousLeafTexts.has(text)) {
      void (element as HTMLElement).offsetWidth;
      element.classList.add("diff-new");
    }
  }
  return nextLeafTexts;
}

function getMeaningfulChildNodes(parent: ParentNode): ChildNode[] {
  return Array.from(parent.childNodes).filter((node) => node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim()));
}

function nodeSignature(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return `text:${node.textContent ?? ""}`;
  }
  return `element:${(node as Element).outerHTML}`;
}

function reconcileRenderedMarkdown(container: HTMLElement, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  const currentNodes = getMeaningfulChildNodes(container);
  const nextNodes = getMeaningfulChildNodes(template.content);
  const currentSignatures = currentNodes.map((node) => nodeSignature(node));
  const nextSignatures = nextNodes.map((node) => nodeSignature(node));

  let prefix = 0;
  while (
    prefix < currentSignatures.length
    && prefix < nextSignatures.length
    && currentSignatures[prefix] === nextSignatures[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < currentSignatures.length - prefix
    && suffix < nextSignatures.length - prefix
    && currentSignatures[currentSignatures.length - 1 - suffix] === nextSignatures[nextSignatures.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  for (let index = prefix; index < currentNodes.length - suffix; index += 1) {
    currentNodes[index]?.remove();
  }

  const anchor = currentNodes[currentNodes.length - suffix] ?? null;
  const fragment = document.createDocumentFragment();
  for (let index = prefix; index < nextNodes.length - suffix; index += 1) {
    fragment.appendChild(nextNodes[index]);
  }
  container.insertBefore(fragment, anchor);
}

interface SelectionSnapshot {
  start: number;
  end: number;
  text: string;
  prefixContext: string;
  suffixContext: string;
}

function getAbsoluteTextOffset(container: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function captureSelectionSnapshot(container: HTMLElement): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const startContainer = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer as Element | null;
  const endContainer = range.endContainer.nodeType === Node.TEXT_NODE
    ? range.endContainer.parentElement
    : range.endContainer as Element | null;
  if (!startContainer || !endContainer || !container.contains(startContainer) || !container.contains(endContainer)) {
    return null;
  }
  const fullText = container.textContent ?? "";
  const start = getAbsoluteTextOffset(container, range.startContainer, range.startOffset);
  const end = getAbsoluteTextOffset(container, range.endContainer, range.endOffset);
  const safeStart = Math.max(0, Math.min(start, fullText.length));
  const safeEnd = Math.max(safeStart, Math.min(end, fullText.length));
  return {
    start: safeStart,
    end: safeEnd,
    text: fullText.slice(safeStart, safeEnd),
    prefixContext: fullText.slice(Math.max(0, safeStart - 32), safeStart),
    suffixContext: fullText.slice(safeEnd, Math.min(fullText.length, safeEnd + 32)),
  };
}

function resolveTextNodePosition(container: HTMLElement, absoluteOffset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let current = walker.nextNode();
  while (current) {
    const textLength = current.textContent?.length ?? 0;
    if (absoluteOffset <= traversed + textLength) {
      return {
        node: current,
        offset: Math.max(0, absoluteOffset - traversed),
      };
    }
    traversed += textLength;
    current = walker.nextNode();
  }
  if (container.lastChild) {
    const lastTextNode = (() => {
      const reverseWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      let next = reverseWalker.nextNode();
      while (next) {
        last = next;
        next = reverseWalker.nextNode();
      }
      return last;
    })();
    if (lastTextNode) {
      return {
        node: lastTextNode,
        offset: lastTextNode.textContent?.length ?? 0,
      };
    }
  }
  return null;
}

function scoreSelectionMatch(fullText: string, start: number, snapshot: SelectionSnapshot): number {
  let score = 0;
  if (snapshot.text && fullText.slice(start, start + snapshot.text.length) === snapshot.text) {
    score += 10;
  }
  const prefixStart = Math.max(0, start - snapshot.prefixContext.length);
  if (snapshot.prefixContext && fullText.slice(prefixStart, start) === snapshot.prefixContext) {
    score += 5;
  }
  const suffixEnd = Math.min(fullText.length, start + snapshot.text.length + snapshot.suffixContext.length);
  if (snapshot.suffixContext && fullText.slice(start + snapshot.text.length, suffixEnd) === snapshot.suffixContext) {
    score += 5;
  }
  score -= Math.abs(start - snapshot.start) / 1000;
  return score;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findAnchoredSelectionStart(fullText: string, snapshot: SelectionSnapshot): number | null {
  const boundedStart = Math.min(snapshot.start, fullText.length);
  const boundedEnd = Math.min(snapshot.end, fullText.length);
  if (boundedEnd <= fullText.length && fullText.slice(boundedStart, boundedEnd) === snapshot.text) {
    return boundedStart;
  }
  const boundedPrefixStart = Math.max(0, boundedStart - snapshot.prefixContext.length);
  if (
    snapshot.prefixContext
    && fullText.slice(boundedPrefixStart, boundedStart) === snapshot.prefixContext
  ) {
    return boundedStart;
  }
  if (!snapshot.text) {
    return boundedStart;
  }

  let bestStart = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  if (snapshot.prefixContext) {
    let searchFrom = 0;
    while (searchFrom <= fullText.length) {
      const matchIndex = fullText.indexOf(snapshot.prefixContext, searchFrom);
      if (matchIndex === -1) {
        break;
      }
      const candidateStart = matchIndex + snapshot.prefixContext.length;
      let score = 8;
      score -= Math.abs(candidateStart - snapshot.start) / 500;
      if (candidateStart < snapshot.start) {
        score -= 5;
      }
      const prefixLength = commonPrefixLength(snapshot.text, fullText.slice(candidateStart));
      score += prefixLength / Math.max(1, snapshot.text.length);
      if (score > bestScore) {
        bestScore = score;
        bestStart = candidateStart;
      }
      searchFrom = matchIndex + Math.max(1, snapshot.prefixContext.length);
    }
  }

  if (bestStart === -1) {
    let searchFrom = 0;
    const probe = snapshot.text.slice(0, Math.min(snapshot.text.length, 24));
    while (probe && searchFrom <= fullText.length) {
      const matchIndex = fullText.indexOf(probe, searchFrom);
      if (matchIndex === -1) {
        break;
      }
      let score = 4;
      score -= Math.abs(matchIndex - snapshot.start) / 500;
      if (matchIndex < snapshot.start) {
        score -= 5;
      }
      const prefixLength = commonPrefixLength(snapshot.text, fullText.slice(matchIndex));
      score += prefixLength / Math.max(1, snapshot.text.length);
      if (score > bestScore) {
        bestScore = score;
        bestStart = matchIndex;
      }
      searchFrom = matchIndex + Math.max(1, probe.length);
    }
  }

  return bestStart === -1 ? null : bestStart;
}

function findSelectionOffsets(fullText: string, snapshot: SelectionSnapshot): { start: number; end: number } | null {
  const anchoredStart = findAnchoredSelectionStart(fullText, snapshot);
  if (anchoredStart !== null) {
    if (!snapshot.text) {
      return { start: anchoredStart, end: anchoredStart };
    }
    const exactSlice = fullText.slice(anchoredStart, anchoredStart + snapshot.text.length);
    if (exactSlice === snapshot.text) {
      return { start: anchoredStart, end: anchoredStart + snapshot.text.length };
    }
    const prefixLength = commonPrefixLength(snapshot.text, fullText.slice(anchoredStart));
    if (prefixLength > 0) {
      return { start: anchoredStart, end: anchoredStart + prefixLength };
    }
  }

  if (!snapshot.text) {
    const position = Math.min(snapshot.start, fullText.length);
    return { start: position, end: position };
  }

  let bestStart = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let searchFrom = 0;
  while (searchFrom <= fullText.length) {
    const matchIndex = fullText.indexOf(snapshot.text, searchFrom);
    if (matchIndex === -1) {
      break;
    }
    const score = scoreSelectionMatch(fullText, matchIndex, snapshot) - (matchIndex < snapshot.start ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestStart = matchIndex;
    }
    searchFrom = matchIndex + Math.max(1, snapshot.text.length);
  }
  if (bestStart === -1) {
    return null;
  }
  return {
    start: bestStart,
    end: bestStart + snapshot.text.length,
  };
}

function restoreSelectionSnapshot(container: HTMLElement, snapshot: SelectionSnapshot): void {
  const fullText = container.textContent ?? "";
  const offsets = findSelectionOffsets(fullText, snapshot);
  const fallbackStart = findAnchoredSelectionStart(fullText, snapshot);
  const targetOffsets = offsets ?? (
    fallbackStart !== null
      ? {
          start: fallbackStart,
          end: fallbackStart + commonPrefixLength(snapshot.text, fullText.slice(fallbackStart)),
        }
      : null
  );
  if (!targetOffsets) {
    return;
  }
  const safeStart = Math.max(0, Math.min(targetOffsets.start, fullText.length));
  const safeEnd = Math.max(safeStart, Math.min(targetOffsets.end, fullText.length));
  const startPosition = resolveTextNodePosition(container, safeStart);
  const endPosition = resolveTextNodePosition(container, safeEnd);
  if (!startPosition || !endPosition) {
    return;
  }
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectionInsideContainer(container: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const startContainer = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer as Element | null;
  const endContainer = range.endContainer.nodeType === Node.TEXT_NODE
    ? range.endContainer.parentElement
    : range.endContainer as Element | null;
  return Boolean(startContainer && endContainer && container.contains(startContainer) && container.contains(endContainer));
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

export function MinutesPage() {
  const { isAdmin, csrfToken } = useAuthSession();
  const paths = useMemo(() => getPaths(), []);
  const [minuteJob, setMinuteJob] = useState<MinuteJobRecord | null>(null);
  const [detailsMeetingRunId, setDetailsMeetingRunId] = useState<string | null>(null);
  const [version, setVersion] = useState<MinuteVersionRecord | null>(null);
  const [minuteTemplates, setMinuteTemplates] = useState<MinutePromptTemplate[]>(BUILTIN_MINUTE_PROMPT_TEMPLATES);
  const [minutePresets, setMinutePresets] = useState<MinutePromptPresetRecord[]>([]);
  const [defaultMinuteProvider, setDefaultMinuteProvider] = useState<UiMinuteProvider>("claude_tmux");
  const [defaultOpenRouterModel, setDefaultOpenRouterModel] = useState("");
  const [content, setContent] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "starting" | "restarting" | "recovering" | "stopping">("idle");
  const [streamState, setStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [updatedLabel, setUpdatedLabel] = useState("Waiting for first minute snapshot…");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const markdownRootRef = useRef<HTMLDivElement | null>(null);
  const previousLeafTextsRef = useRef(new Set<string>());
  const lastMarkdownRef = useRef("");
  const windowStickBottomRef = useRef(true);
  const pendingSelectionRef = useRef<SelectionSnapshot | null>(null);
  const runningFields = useMemo<MinuteDraftFields | null>(() => {
    if (!minuteJob) {
      return null;
    }
    return {
      provider: minuteJob.provider ?? defaultMinuteProvider,
      promptTemplateId: minuteJob.prompt_template_id ?? BUILTIN_MINUTE_PROMPT_TEMPLATES[0]?.template_id ?? "formal-working-group-minutes",
      promptBody: minuteJob.user_prompt_body ?? "",
      claudeModel: minuteJob.claude_model ?? "",
      claudeEffort: minuteJob.claude_effort ?? "",
      openrouterModel: minuteJob.openrouter_model ?? "",
    };
  }, [
    minuteJob?.minute_job_id,
    minuteJob?.provider,
    minuteJob?.prompt_template_id,
    minuteJob?.user_prompt_body,
    minuteJob?.claude_model,
    minuteJob?.claude_effort,
    minuteJob?.openrouter_model,
    defaultMinuteProvider,
  ]);
  const minuteDraft = useMinutePresetDraftManager({
    templates: minuteTemplates,
    savedPresets: minutePresets,
    runningFields,
    runningPromptLabel: minuteJob?.prompt_label ?? null,
    preferRunningPreset: Boolean(minuteJob),
    defaultProvider: defaultMinuteProvider,
    defaultOpenRouterModel,
    onSavePreset: async ({ name, fields }) => {
      const response = await postJson<{ preset: MinutePromptPresetRecord }>("/v1/minute-prompt-presets", {
        name,
        ...minutePromptRequestBody(minuteTemplates, fields, name, defaultMinuteProvider),
      }, {
        headers: { "x-meter-csrf": csrfToken ?? "" },
      });
      setMinutePresets((current) => {
        const next = current.filter((preset) => preset.name.toLowerCase() !== response.preset.name.toLowerCase());
        return [...next, response.preset];
      });
      return response.preset;
    },
    onDeletePreset: async (name) => {
      await deleteJson(`/v1/minute-prompt-presets/${encodeURIComponent(name)}`, {
        headers: { "x-meter-csrf": csrfToken ?? "" },
      });
      setMinutePresets((current) => current.filter((preset) => preset.name !== name));
    },
  });

  const renderedContent = useMemo(() => renderMinutesMarkdown(content), [content]);

  const applyIncomingMarkdown = (markdown: string, updatedLabelText: string) => {
    const container = markdownRootRef.current;
    if (container) {
      pendingSelectionRef.current = captureSelectionSnapshot(container);
    }
    const wasNearBottom = windowStickBottomRef.current || isWindowNearBottom();
    lastMarkdownRef.current = markdown;
    setContent(markdown);
    setUpdatedLabel(updatedLabelText);
    if (wasNearBottom) {
      scrollWindowToBottom();
    }
  };

  const loadDetails = async (forceDraftReset = false) => {
    if (!paths.detailsPath) {
      return;
    }
    const response = await fetch(paths.detailsPath, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load minute details (${response.status})`);
    }
      const payload = await response.json() as MinuteDetailsResponse;
      setDetailsMeetingRunId(payload.meeting_run_id);
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
      setMinutePresets(payload.saved_presets ?? []);
      setDefaultMinuteProvider(payload.default_provider === "openrouter_patch" ? "openrouter_patch" : "claude_tmux");
      setDefaultOpenRouterModel(payload.default_openrouter_model?.trim() || "");
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
      applyIncomingMarkdown(
        markdown,
        reason === "initial" ? `Loaded ${new Date().toLocaleString()}` : `Updated ${new Date().toLocaleString()} · polled raw markdown`,
      );
    } catch {
      // ignore; stream may still succeed
    }
  };

  useEffect(() => {
    if (paths.title) {
      document.title = `${paths.title} Minutes`;
    }
    void loadTemplates();
    void loadDetails(true).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load minute details");
    });
    void fetchLatestMarkdown("initial");
  }, []);

  useLayoutEffect(() => {
    const markdownRoot = markdownRootRef.current;
    if (!markdownRoot) {
      return;
    }
    reconcileRenderedMarkdown(markdownRoot, renderedContent);
    const nextLeafTexts = applyMarkdownHighlights(markdownRoot, previousLeafTextsRef.current);
    previousLeafTextsRef.current = nextLeafTexts;
    if (pendingSelectionRef.current) {
      if (!selectionInsideContainer(markdownRoot)) {
        restoreSelectionSnapshot(markdownRoot, pendingSelectionRef.current);
      }
      pendingSelectionRef.current = null;
    }
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
    };
    eventSource.onerror = () => {
      setStreamState("reconnecting");
    };
    eventSource.addEventListener("heartbeat", () => {
      setStreamState("live");
    });
    eventSource.addEventListener("minutes", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StreamPayload;
      setMinuteJob(payload.minute_job);
      setVersion(payload.version);
      setStreamState("live");
      if (payload.content_markdown !== lastMarkdownRef.current) {
        applyIncomingMarkdown(
          payload.content_markdown,
          `Updated ${new Date(payload.version.created_at).toLocaleString()} · version ${payload.version.seq}`,
        );
      } else {
        setUpdatedLabel(`Updated ${new Date(payload.version.created_at).toLocaleString()} · version ${payload.version.seq}`);
      }
    });

    return () => {
      window.clearInterval(pollTimer);
      eventSource.close();
    };
  }, [paths.streamPath]);

  const submit = async (action: "start" | "restart" | "recover" | "stop") => {
    const fallbackMeetingRunId = minuteJob?.meeting_run_id ?? detailsMeetingRunId;
    const fallbackEndpoint = fallbackMeetingRunId
      ? action === "start"
        ? `/v1/meeting-runs/${fallbackMeetingRunId}/minutes/start`
        : action === "restart"
          ? `/v1/meeting-runs/${fallbackMeetingRunId}/minutes/restart`
          : action === "recover"
            ? `/v1/meeting-runs/${fallbackMeetingRunId}/minutes/recover`
          : `/v1/meeting-runs/${fallbackMeetingRunId}/minutes/stop`
      : null;
    const endpoint = (
      action === "start"
        ? paths.startPath
        : action === "restart"
          ? paths.restartPath
          : action === "recover"
            ? paths.recoverPath
            : paths.stopPath
    ) ?? fallbackEndpoint;
    if (!endpoint || !isAdmin) {
      return;
    }
    setError(null);
    setRequestState(
      action === "start"
        ? "starting"
        : action === "restart"
          ? "restarting"
          : action === "recover"
            ? "recovering"
            : "stopping",
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-meter-csrf": csrfToken ?? "",
        },
        credentials: "include",
        body: JSON.stringify(action === "stop"
          ? {}
          : action === "recover"
            ? {}
          : minutePromptRequestBody(minuteTemplates, minuteDraft.currentFields, minuteDraft.promptLabel, defaultMinuteProvider)),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? `Failed to ${action} minutes`);
      }
      const payload = await response.json().catch(() => null) as { minute_job?: MinuteJobRecord | null } | null;
      if (action === "stop") {
        await loadDetails(true);
        await fetchLatestMarkdown("poll");
      } else {
        const nextMinuteJob = payload?.minute_job ?? null;
        if (nextMinuteJob) {
          setMinuteJob(nextMinuteJob);
        }
        setVersion(null);
        if (action !== "recover") {
          setContent("");
          lastMarkdownRef.current = "";
          previousLeafTextsRef.current = new Set();
          pendingSelectionRef.current = null;
          setUpdatedLabel("Waiting for first minute snapshot…");
        } else {
          setUpdatedLabel("Recovering from the latest saved minutes…");
        }
        setStreamState("connecting");
        setSettingsOpen(false);
        await loadDetails(false).catch(() => undefined);
        if (action === "recover") {
          await fetchLatestMarkdown("poll");
        }
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Failed to ${action} minutes`);
    } finally {
      setRequestState("idle");
    }
  };

  const currentState = minuteJob?.state ?? "idle";
  const minuteUiState = getMinuteUiState(minuteJob, version);
  const canRecover = Boolean(
    minuteJob
    && paths.recoverPath
    && !["starting", "running", "restarting", "stopping"].includes(currentState),
  );
  const primaryAction = !minuteJob ? "start" : canRecover ? "recover" : "restart";
  const primaryLabel = !minuteJob
    ? "Start minutes"
    : canRecover
      ? "Recover minutes"
      : "Restart minutes";
  const workspaceClassName = `workspace ${settingsOpen ? "with-settings" : "viewer-only"}`;
  const settingsToggleLabel = settingsOpen ? "Hide settings" : minuteJob ? "Minute settings" : "Configure minutes";

  return (
    <>
      <style>{styles}</style>
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
            <AuthStatusControl />
            <a className="action-link" href="/">Back to dashboard</a>
            {paths.transcriptPath ? (
              <a className="action-link" href={paths.transcriptPath}>Open transcript</a>
            ) : null}
            <a className="action-link" href={paths.markdownPath} target="_blank" rel="noreferrer">Open raw markdown</a>
            <button className="ghost-button" onClick={() => setSettingsOpen((open) => !open)} type="button">
              {settingsToggleLabel}
            </button>
            <div className="status" ref={(node) => setStatusClass(node, streamState)}>
              <span className="status-dot"></span>
              <span>{streamState === "reconnecting" ? "Reconnecting" : minuteUiState.statusLabel}</span>
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
          <div className="meta-row">
            <span className={`pill pill-${currentState}`}>{currentState}</span>
          </div>
          <MinutePromptEditor
            templates={minuteTemplates}
            minuteDraft={minuteDraft}
            disabled={requestState !== "idle" || !isAdmin}
            includeRunSource={Boolean(minuteJob)}
          />
          <div className="button-row">
            <button className="primary-button" disabled={requestState !== "idle" || !isAdmin} onClick={() => void submit(primaryAction)} type="button">
              {requestState === (
                primaryAction === "start"
                  ? "starting"
                  : primaryAction === "recover"
                    ? "recovering"
                    : "restarting"
              )
                ? primaryAction === "start"
                  ? "Starting…"
                  : primaryAction === "recover"
                    ? "Recovering…"
                    : "Restarting…"
                : primaryLabel}
            </button>
            <button className="ghost-button" disabled={requestState !== "idle" || !isAdmin || !minuteJob || !["starting", "running", "restarting", "stopping"].includes(currentState)} onClick={() => void submit("stop")} type="button">
              {requestState === "stopping" ? "Stopping…" : "Stop minutes"}
            </button>
          </div>
          {!isAdmin ? <div className="inline-error">Admin unlock required for minute controls.</div> : null}
          {minuteJob ? (
            <div className="meta-row">
              <span>{minuteJob.provider === "openrouter_patch" ? "OpenRouter backend" : "Claude backend"}</span>
              <span>{describeMinuteBackend(minuteJob)}</span>
            </div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}
        </aside>
        ) : null}

        <section className="panel viewer-shell">
          <div className="viewer-head">
            <div>
              <p className="eyebrow">Rendered minutes</p>
              <h2>{minuteUiState.title}</h2>
            </div>
            <div className="viewer-meta">
              <span>{updatedLabel}</span>
            </div>
          </div>
          <div className="viewer">
            {content ? (
              <div className="minutes-markdown" ref={markdownRootRef} />
            ) : (
              <div className="empty">Waiting for minutes…</div>
            )}
          </div>
        </section>
        </section>
      </main>
    </>
  );
}
