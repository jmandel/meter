import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  fetchMeetingRun,
  fetchTranscriptMd,
  type MeterClient,
} from "./api-client";
import { processResponse, type CursorTracker } from "./diff-tracker";
import { DEFAULT_OPENROUTER_MINUTE_MODEL } from "../src/minute-models";
import { buildSystemPrompt } from "./prompt";

export interface OpenRouterMinuteConfig {
  meetingId: string;
  meetingRunId: string;
  botName?: string | null;
  runDir: string;
  pollIntervalMs: number;
  promptTemplateId?: string | null;
  userPromptBody?: string | null;
  openrouterModel?: string | null;
}

export interface OpenRouterRuntimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  title?: string | null;
  referer?: string | null;
}

type PatchEdit =
  | {
      op: "str_replace_once";
      old: string;
      new: string;
    }
  | {
      op: "insert_after_once";
      after: string;
      text: string;
    }
  | {
      op: "append";
      text: string;
    };

interface RawPatchResponse {
  edits?: unknown;
  rewrite_file?: unknown;
  operation?: unknown;
  content?: unknown;
  text?: unknown;
}

export interface ParsedPatchResponse {
  edits: PatchEdit[];
  rewriteFile: string | null;
  responseShape: "canonical" | "legacy_single_op";
}

export function splitTranscriptForMessages(text: string, maxChars = 12_000): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > maxChars) {
      blocks.push(current);
      current = line;
      continue;
    }
    current = candidate;
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}

export function parsePatchResponse(value: unknown): ParsedPatchResponse {
  if (!value || typeof value !== "object") {
    throw new Error("OpenRouter patch response must be a JSON object");
  }
  const raw = value as RawPatchResponse;
  if (typeof raw.operation === "string") {
    // Some providers/models ignore the requested schema and return a single-op
    // wrapper like {"operation":"rewrite_file","content":"..."}. Accept the
    // common variants so the backend still produces minutes, but keep the
    // canonical schema above as the primary contract.
    if (raw.operation === "rewrite_file") {
      if (typeof raw.content !== "string" || raw.content.length === 0) {
        throw new Error("OpenRouter rewrite_file response requires non-empty string \"content\"");
      }
      return { edits: [], rewriteFile: raw.content, responseShape: "legacy_single_op" };
    }
    if (raw.operation === "append") {
      const text = typeof raw.text === "string"
        ? raw.text
        : typeof raw.content === "string"
          ? raw.content
          : null;
      if (text === null) {
        throw new Error("OpenRouter append response requires string \"text\" or \"content\"");
      }
      return { edits: [{ op: "append", text }], rewriteFile: null, responseShape: "legacy_single_op" };
    }
    throw new Error(`Unsupported OpenRouter legacy operation shape: ${raw.operation}`);
  }
  const rewriteFile = typeof raw.rewrite_file === "string" && raw.rewrite_file.length > 0
    ? raw.rewrite_file
    : null;
  const edits: PatchEdit[] = [];
  if (raw.edits !== undefined) {
    if (!Array.isArray(raw.edits)) {
      throw new Error("OpenRouter patch response field \"edits\" must be an array");
    }
    for (const [index, item] of raw.edits.entries()) {
      if (!item || typeof item !== "object") {
        throw new Error(`Patch edit ${index} must be an object`);
      }
      const record = item as Record<string, unknown>;
      if (record.op === "str_replace_once") {
        if (typeof record.old !== "string" || typeof record.new !== "string") {
          throw new Error(`Patch edit ${index} requires string "old" and "new" fields`);
        }
        edits.push({ op: "str_replace_once", old: record.old, new: record.new });
        continue;
      }
      if (record.op === "insert_after_once") {
        if (typeof record.after !== "string" || typeof record.text !== "string") {
          throw new Error(`Patch edit ${index} requires string "after" and "text" fields`);
        }
        edits.push({ op: "insert_after_once", after: record.after, text: record.text });
        continue;
      }
      if (record.op === "append") {
        if (typeof record.text !== "string") {
          throw new Error(`Patch edit ${index} requires string "text" field`);
        }
        edits.push({ op: "append", text: record.text });
        continue;
      }
      throw new Error(`Unsupported patch op at index ${index}: ${String(record.op)}`);
    }
  }
  if (raw.edits === undefined && raw.rewrite_file === undefined) {
    throw new Error("OpenRouter patch response must include \"edits\" or \"rewrite_file\"");
  }
  if (rewriteFile === null && edits.length === 0) {
    return { edits: [], rewriteFile: null, responseShape: "canonical" };
  }
  return { edits, rewriteFile, responseShape: "canonical" };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      return count;
    }
    count += 1;
    from = index + needle.length;
  }
}

export function applyPatchResponse(current: string, patch: ParsedPatchResponse): string {
  if (patch.rewriteFile !== null) {
    return patch.rewriteFile;
  }
  let next = current;
  for (const edit of patch.edits) {
    if (edit.op === "str_replace_once") {
      const matches = countOccurrences(next, edit.old);
      if (matches !== 1) {
        throw new Error(`str_replace_once expected 1 match, found ${matches}`);
      }
      next = next.replace(edit.old, edit.new);
      continue;
    }
    if (edit.op === "insert_after_once") {
      const matches = countOccurrences(next, edit.after);
      if (matches !== 1) {
        throw new Error(`insert_after_once expected 1 match, found ${matches}`);
      }
      next = next.replace(edit.after, `${edit.after}${edit.text}`);
      continue;
    }
    if (edit.op === "append") {
      next += edit.text;
    }
  }
  return next;
}

function minutePatchSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      edits: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: {
                  type: "string",
                  const: "str_replace_once",
                },
                old: { type: "string" },
                new: { type: "string" },
              },
              required: ["op", "old", "new"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: {
                  type: "string",
                  const: "insert_after_once",
                },
                after: { type: "string" },
                text: { type: "string" },
              },
              required: ["op", "after", "text"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: {
                  type: "string",
                  const: "append",
                },
                text: { type: "string" },
              },
              required: ["op", "text"],
            },
          ],
        },
      },
      rewrite_file: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
    },
    required: ["edits", "rewrite_file"],
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const record = item as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  return "";
}

function readMinutes(runDir: string): string {
  try {
    return readFileSync(`${runDir}/minutes.md`, "utf-8");
  } catch {
    return "";
  }
}

function writeDebugFile(path: string, value: unknown): void {
  writeFileSync(path, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function writeApplyLog(runDir: string, value: unknown): void {
  writeDebugFile(`${runDir}/.openrouter-last-apply.json`, value);
}

async function callOpenRouter(
  runtime: OpenRouterRuntimeOptions,
  messages: Array<Record<string, unknown>>,
  runDir: string,
): Promise<ParsedPatchResponse> {
  const payload = {
    model: runtime.model,
    temperature: 0,
    provider: {
      require_parameters: true,
    },
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "minutes_patch",
        strict: true,
        schema: minutePatchSchema(),
      },
    },
  };
  writeDebugFile(`${runDir}/.openrouter-last-request.json`, payload);
  const response = await fetch(`${runtime.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.apiKey}`,
      "content-type": "application/json",
      ...(runtime.title ? { "x-title": runtime.title } : {}),
      ...(runtime.referer ? { "http-referer": runtime.referer } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(async () => ({ raw_text: await response.text() }));
  writeDebugFile(`${runDir}/.openrouter-last-response.json`, body);
  if (!response.ok) {
    const message = body && typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify((body as Record<string, unknown>).error)
      : JSON.stringify(body);
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} ${message}`);
  }
  const choices = body && typeof body === "object" && body !== null && "choices" in body
    ? (body as Record<string, unknown>).choices
    : null;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenRouter response did not include choices");
  }
  const message = (choices[0] as Record<string, unknown>).message;
  const rawContent = message && typeof message === "object"
    ? (message as Record<string, unknown>).content
    : null;
  const text = extractTextContent(rawContent).trim();
  if (!text) {
    writeApplyLog(runDir, {
      stage: "parse_error",
      reason: "missing_message_content",
      at: new Date().toISOString(),
    });
    throw new Error("OpenRouter response did not include message content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    writeApplyLog(runDir, {
      stage: "parse_error",
      reason: "invalid_json",
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      raw_text_preview: text.slice(0, 4000),
    });
    throw new Error(`OpenRouter response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const patch = parsePatchResponse(parsed);
  writeApplyLog(runDir, {
    stage: "parsed",
    at: new Date().toISOString(),
    response_shape: patch.responseShape,
    edit_count: patch.edits.length,
    edit_ops: patch.edits.map((edit) => edit.op),
    has_rewrite_file: patch.rewriteFile !== null,
    rewrite_file_length: patch.rewriteFile?.length ?? 0,
  });
  return patch;
}

function buildPatchMessages(input: {
  meetingId: string;
  meetingRunId: string;
  botName?: string | null;
  promptTemplateId?: string | null;
  userPromptBody?: string | null;
  transcriptMarkdown: string;
  currentMinutes: string;
  isFinal: boolean;
}): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: buildSystemPrompt({
        meetingId: input.meetingId,
        meetingRunId: input.meetingRunId,
        botName: input.botName ?? null,
        promptTemplateId: input.promptTemplateId ?? null,
        userPromptBody: input.userPromptBody ?? null,
      }),
    },
    {
      role: "user",
      content: [
        "You are updating a single Markdown file named minutes.md.",
        "Return JSON only. Do not return prose outside the JSON object.",
        "Prefer exact text edits over full rewrites when the current file can be updated cleanly.",
        "Available operations:",
        "- str_replace_once: replace one exact existing substring in minutes.md",
        "- insert_after_once: insert new text immediately after one exact existing substring in minutes.md",
        "- append: append text to the end of minutes.md",
        "- rewrite_file: replace the full file only when targeted edits would be awkward or brittle",
        "If you emit exact-match operations, each anchor must be copied exactly from the current minutes.md text shown below.",
        "The JSON envelope must have exactly these top-level fields: \"edits\" and \"rewrite_file\".",
        "Canonical shape for targeted edits:",
        "{\"edits\":[{\"op\":\"str_replace_once\",\"old\":\"TEXT_TO_FIND\",\"new\":\"REPLACEMENT_TEXT\"},{\"op\":\"insert_after_once\",\"after\":\"ANCHOR_TEXT\",\"text\":\"TEXT_TO_INSERT\"},{\"op\":\"append\",\"text\":\"TEXT_TO_APPEND\"}],\"rewrite_file\":null}",
        "Canonical shape for a full rewrite:",
        "{\"edits\":[],\"rewrite_file\":\"FULL_MARKDOWN_HERE\"}",
        "Do not invent alternate wrapper keys like \"operation\" or \"content\".",
      ].join("\n"),
    },
  ];
  const transcriptBlocks = splitTranscriptForMessages(input.transcriptMarkdown);
  if (transcriptBlocks.length === 0) {
    messages.push({
      role: "user",
      content: "Transcript so far:\n\n_No transcript content yet._",
    });
  } else {
    for (const [index, block] of transcriptBlocks.entries()) {
      messages.push({
        role: "user",
        content: `Transcript block ${index + 1}/${transcriptBlocks.length}:\n\n${block}`,
      });
    }
  }
  messages.push({
    role: "user",
    content: `Current minutes.md:\n\n${input.currentMinutes || "_File does not exist yet._"}`,
  });
  messages.push({
    role: "user",
    content: input.isFinal
      ? "The meeting has ended. Do a final cleanup pass: process any remaining transcript content, smooth rough live phrasing, and leave minutes.md as a completed document."
      : "The meeting is still in progress. Keep writing incremental live minutes even if some sections remain incomplete, and refine earlier notes when the newer transcript makes the meaning clearer.",
  });
  return messages;
}

export async function runOpenRouterMinuteTaker(input: {
  client: MeterClient;
  config: OpenRouterMinuteConfig;
  tracker: CursorTracker;
}): Promise<void> {
  const apiKey = process.env.METER_OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error("OpenRouter minute-taker requires METER_OPENROUTER_API_KEY or OPENROUTER_API_KEY");
  }
  const model = input.config.openrouterModel?.trim() || process.env.METER_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MINUTE_MODEL;
  const runtime: OpenRouterRuntimeOptions = {
    apiKey,
    model,
    baseUrl: process.env.METER_OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    title: process.env.METER_OPENROUTER_TITLE?.trim() || "Meter minute-taker",
    referer: process.env.METER_OPENROUTER_REFERER?.trim() || process.env.METER_PUBLIC_BASE_URL?.trim() || null,
  };

  mkdirSync(`${input.config.runDir}/chunks`, { recursive: true });
  let consecutiveErrors = 0;
  let pollCount = 0;
  let lastTranscript = "";
  let finalized = false;

  while (!finalized) {
    pollCount += 1;
    try {
      const meetingRun = await fetchMeetingRun(input.client, input.config.meetingRunId);
      const transcript = await fetchTranscriptMd(input.client, input.config.meetingRunId);
      const chunk = processResponse(input.tracker, transcript);
      if (chunk) {
        writeFileSync(
          `${input.config.runDir}/chunks/${String(chunk.segmentIndex).padStart(4, "0")}.md`,
          `${chunk.content}\n`,
        );
        console.log(`OpenRouter chunk ${chunk.segmentIndex}: ${chunk.content.split("\n").length} lines`);
      } else {
        console.log(`OpenRouter poll ${pollCount}: no transcript change`);
      }
      const terminal = ["completed", "failed", "aborted"].includes(meetingRun.state);
      const shouldGenerate = transcript !== lastTranscript || terminal;
      if (shouldGenerate) {
        const currentMinutes = readMinutes(input.config.runDir);
        if (transcript.trim() || currentMinutes || terminal) {
          const messages = buildPatchMessages({
            meetingId: input.config.meetingId,
            meetingRunId: input.config.meetingRunId,
            botName: input.config.botName ?? null,
            promptTemplateId: input.config.promptTemplateId ?? null,
            userPromptBody: input.config.userPromptBody ?? null,
            transcriptMarkdown: transcript,
            currentMinutes,
            isFinal: terminal,
          });
          const patch = await callOpenRouter(runtime, messages, input.config.runDir);
          const nextMinutes = applyPatchResponse(currentMinutes, patch);
          writeApplyLog(input.config.runDir, {
            stage: "applied",
            at: new Date().toISOString(),
            response_shape: patch.responseShape,
            terminal,
            changed: nextMinutes !== currentMinutes,
            previous_length: currentMinutes.length,
            next_length: nextMinutes.length,
            last_chunk_index: input.tracker.lastSegmentIndex,
          });
          if (nextMinutes !== currentMinutes) {
            writeFileSync(`${input.config.runDir}/minutes.md`, nextMinutes);
          }
        }
        lastTranscript = transcript;
      }
      consecutiveErrors = 0;
      if (terminal) {
        finalized = true;
        break;
      }
    } catch (error) {
      consecutiveErrors += 1;
      console.error(`OpenRouter minute poll error (${consecutiveErrors}/10):`, error);
      if (consecutiveErrors >= 10) {
        throw error;
      }
    }
    await Bun.sleep(input.config.pollIntervalMs);
  }
}
