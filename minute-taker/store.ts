import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z, ZodError } from "zod";

import type { AttendeeSummaryRecord } from "../src/domain";
import {
  applyMinutesPatch,
  createMinutesState,
  renderMinutesMarkdown,
  type MinutesAttendee,
  type MinutesMeetingRef,
  type MinutesPatchOperation,
  type MinutesState,
} from "./state";

export const MinutesMeetingStatusSchema = z.enum(["live", "completed", "failed", "aborted"]);
export const MinutesSourceRefSchema = z.object({
  ts: z.string().min(1),
  kind: z.enum(["speech", "chat", "joins", "leaves"]).optional(),
});
export const MinutesAttendeeSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullable().optional(),
  present: z.boolean().optional(),
});
export const MinutesTodoSchema = z.object({
  text: z.string().min(1),
  assignee: z.string().nullable().optional(),
  done: z.boolean(),
  sourceRefs: z.array(MinutesSourceRefSchema),
});
export const MinutesSectionSchema = z.object({
  sectionId: z.string().min(1),
  title: z.string().min(1),
  bullets: z.array(z.string()),
  decisions: z.array(z.string()),
  todos: z.array(MinutesTodoSchema),
  sourceRefs: z.array(MinutesSourceRefSchema),
});
export const MinutesMeetingRefSchema = z.object({
  meetingId: z.string().min(1),
  meetingRunId: z.string().min(1),
  title: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  status: MinutesMeetingStatusSchema,
});
export const MinutesStateSchema = z.object({
  meeting: MinutesMeetingRefSchema,
  attendees: z.array(MinutesAttendeeSchema),
  sections: z.array(MinutesSectionSchema),
  summary: z.array(z.string()),
});
export const MinutesPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("merge_attendees"),
    attendees: z.array(MinutesAttendeeSchema),
  }),
  z.object({
    op: z.literal("upsert_section"),
    sectionId: z.string().min(1),
    title: z.string().min(1),
    sourceRefs: z.array(MinutesSourceRefSchema).optional(),
  }),
  z.object({
    op: z.literal("append_bullet"),
    sectionId: z.string().min(1),
    text: z.string().min(1),
    sourceRefs: z.array(MinutesSourceRefSchema).optional(),
  }),
  z.object({
    op: z.literal("append_decision"),
    sectionId: z.string().min(1),
    text: z.string().min(1),
    sourceRefs: z.array(MinutesSourceRefSchema).optional(),
  }),
  z.object({
    op: z.literal("append_todo"),
    sectionId: z.string().min(1),
    text: z.string().min(1),
    assignee: z.string().nullable().optional(),
    sourceRefs: z.array(MinutesSourceRefSchema).optional(),
  }),
  z.object({
    op: z.literal("set_summary"),
    summary: z.array(z.string()),
  }),
  z.object({
    op: z.literal("set_status"),
    status: MinutesMeetingStatusSchema,
  }),
]);

export type ValidatedMinutesPatchOperation = z.infer<typeof MinutesPatchOperationSchema>;

export interface MinutesStorePaths {
  runDir: string;
  statePath: string;
  opsPath: string;
  markdownPath: string;
  attendeesPath: string;
  submitCliPath: string;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildPaths(runDir: string): MinutesStorePaths {
  return {
    runDir,
    statePath: path.join(runDir, "minutes.state.json"),
    opsPath: path.join(runDir, "minutes.ops.jsonl"),
    markdownPath: path.join(runDir, "minutes.md"),
    attendeesPath: path.join(runDir, "attendees.md"),
    submitCliPath: path.join(runDir, "minute-op"),
  };
}

export function getMinutesStorePaths(runDir: string): MinutesStorePaths {
  return buildPaths(runDir);
}

export function initializeMinutesStore(runDir: string, meeting: MinutesMeetingRef): MinutesStorePaths {
  const paths = buildPaths(runDir);
  mkdirSync(runDir, { recursive: true });
  if (!existsSync(paths.statePath)) {
    const state = createMinutesState(meeting);
    writeFileSync(paths.statePath, stableJson(MinutesStateSchema.parse(state)));
  }
  if (!existsSync(paths.opsPath)) {
    writeFileSync(paths.opsPath, "");
  }
  syncRenderedMinutes(runDir);
  return paths;
}

export function loadMinutesState(runDir: string): MinutesState {
  const paths = buildPaths(runDir);
  const raw = readFileSync(paths.statePath, "utf-8");
  return MinutesStateSchema.parse(JSON.parse(raw)) as MinutesState;
}

export function saveMinutesState(runDir: string, state: MinutesState): MinutesState {
  const paths = buildPaths(runDir);
  const validated = MinutesStateSchema.parse(state) as MinutesState;
  writeFileSync(paths.statePath, stableJson(validated));
  writeMinutesMarkdownIfChanged(paths.markdownPath, renderMinutesMarkdown(validated));
  return validated;
}

function writeMinutesMarkdownIfChanged(markdownPath: string, content: string): void {
  if (existsSync(markdownPath)) {
    const existing = readFileSync(markdownPath, "utf-8");
    if (existing === content) {
      return;
    }
  }
  writeFileSync(markdownPath, content);
}

export function syncRenderedMinutes(runDir: string): MinutesState {
  const state = loadMinutesState(runDir);
  return saveMinutesState(runDir, state);
}

export function applyMinutesOperation(runDir: string, input: unknown): {
  state: MinutesState;
  operation: ValidatedMinutesPatchOperation;
  paths: MinutesStorePaths;
} {
  const paths = buildPaths(runDir);
  const operation = MinutesPatchOperationSchema.parse(input) as ValidatedMinutesPatchOperation;
  const current = loadMinutesState(runDir);
  const next = applyMinutesPatch(current, operation as MinutesPatchOperation);
  const validated = saveMinutesState(runDir, next);
  appendFileSync(paths.opsPath, `${JSON.stringify(operation)}\n`);
  return {
    state: validated,
    operation,
    paths,
  };
}

function attendeeToMinutesAttendee(attendee: AttendeeSummaryRecord): MinutesAttendee {
  const role = attendee.is_host
    ? "host"
    : attendee.is_co_host
    ? "co-host"
    : attendee.is_guest
    ? "guest"
    : null;
  return {
    name: attendee.display_name?.trim() || attendee.aliases[0] || attendee.attendee_key,
    role,
    present: attendee.present,
  };
}

export function syncAttendeesIntoMinutesState(runDir: string, attendees: AttendeeSummaryRecord[]): {
  state: MinutesState;
  changed: boolean;
} {
  const normalized = attendees.map(attendeeToMinutesAttendee).sort((left, right) => left.name.localeCompare(right.name));
  const current = loadMinutesState(runDir);
  if (JSON.stringify(current.attendees) === JSON.stringify(normalized)) {
    return {
      state: current,
      changed: false,
    };
  }
  const result = applyMinutesOperation(runDir, {
    op: "merge_attendees",
    attendees: normalized,
  });
  return {
    state: result.state,
    changed: true,
  };
}

export function formatZodError(error: ZodError): string {
  return JSON.stringify({
    name: error.name,
    issues: error.issues,
  }, null, 2);
}
