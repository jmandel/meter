export type MinutesMeetingStatus = "live" | "completed" | "failed" | "aborted";

export interface MinutesMeetingRef {
  meetingId: string;
  meetingRunId: string;
  title?: string | null;
  startedAt?: string | null;
  status: MinutesMeetingStatus;
}

export interface MinutesSourceRef {
  ts: string;
  kind?: "speech" | "chat" | "joins" | "leaves";
}

export interface MinutesAttendee {
  name: string;
  role?: string | null;
  present?: boolean;
}

export interface MinutesTodo {
  text: string;
  assignee?: string | null;
  done: boolean;
  sourceRefs: MinutesSourceRef[];
}

export interface MinutesSection {
  sectionId: string;
  title: string;
  bullets: string[];
  decisions: string[];
  todos: MinutesTodo[];
  sourceRefs: MinutesSourceRef[];
}

export interface MinutesState {
  meeting: MinutesMeetingRef;
  attendees: MinutesAttendee[];
  sections: MinutesSection[];
  summary: string[];
}

export type MinutesPatchOperation =
  | {
      op: "merge_attendees";
      attendees: MinutesAttendee[];
    }
  | {
      op: "upsert_section";
      sectionId: string;
      title: string;
      sourceRefs?: MinutesSourceRef[];
    }
  | {
      op: "append_bullet";
      sectionId: string;
      text: string;
      sourceRefs?: MinutesSourceRef[];
    }
  | {
      op: "append_decision";
      sectionId: string;
      text: string;
      sourceRefs?: MinutesSourceRef[];
    }
  | {
      op: "append_todo";
      sectionId: string;
      text: string;
      assignee?: string | null;
      sourceRefs?: MinutesSourceRef[];
    }
  | {
      op: "set_summary";
      summary: string[];
    }
  | {
      op: "set_status";
      status: MinutesMeetingStatus;
    };

function appendUnique(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

function mergeSourceRefs(current: MinutesSourceRef[], incoming: MinutesSourceRef[] = []): MinutesSourceRef[] {
  const merged = [...current];
  for (const ref of incoming) {
    if (!merged.some((item) => item.ts === ref.ts && item.kind === ref.kind)) {
      merged.push(ref);
    }
  }
  return merged;
}

function upsertSection(
  sections: MinutesSection[],
  sectionId: string,
  title: string,
  sourceRefs: MinutesSourceRef[] = [],
): MinutesSection[] {
  const existing = sections.find((item) => item.sectionId === sectionId);
  if (!existing) {
    return [
      ...sections,
      {
        sectionId,
        title,
        bullets: [],
        decisions: [],
        todos: [],
        sourceRefs,
      },
    ];
  }
  return sections.map((item) => item.sectionId !== sectionId
    ? item
    : {
        ...item,
        title,
        sourceRefs: mergeSourceRefs(item.sourceRefs, sourceRefs),
      });
}

function requireSection(state: MinutesState, sectionId: string): MinutesSection {
  const section = state.sections.find((item) => item.sectionId === sectionId);
  if (!section) {
    throw new Error(`Section ${sectionId} does not exist`);
  }
  return section;
}

export function createMinutesState(meeting: MinutesMeetingRef): MinutesState {
  return {
    meeting,
    attendees: [],
    sections: [],
    summary: [],
  };
}

export function applyMinutesPatch(state: MinutesState, op: MinutesPatchOperation): MinutesState {
  switch (op.op) {
    case "merge_attendees": {
      const merged = [...state.attendees];
      for (const attendee of op.attendees) {
        const index = merged.findIndex((item) => item.name === attendee.name);
        if (index === -1) {
          merged.push(attendee);
          continue;
        }
        merged[index] = {
          ...merged[index],
          ...attendee,
        };
      }
      return {
        ...state,
        attendees: merged.sort((left, right) => left.name.localeCompare(right.name)),
      };
    }
    case "upsert_section":
      return {
        ...state,
        sections: upsertSection(state.sections, op.sectionId, op.title, op.sourceRefs),
      };
    case "append_bullet": {
      const section = requireSection(state, op.sectionId);
      return {
        ...state,
        sections: state.sections.map((item) => item.sectionId !== op.sectionId
          ? item
          : {
              ...section,
              bullets: appendUnique(section.bullets, op.text),
              sourceRefs: mergeSourceRefs(section.sourceRefs, op.sourceRefs),
            }),
      };
    }
    case "append_decision": {
      const section = requireSection(state, op.sectionId);
      return {
        ...state,
        sections: state.sections.map((item) => item.sectionId !== op.sectionId
          ? item
          : {
              ...section,
              decisions: appendUnique(section.decisions, op.text),
              sourceRefs: mergeSourceRefs(section.sourceRefs, op.sourceRefs),
            }),
      };
    }
    case "append_todo": {
      const section = requireSection(state, op.sectionId);
      const exists = section.todos.some((todo) => todo.text === op.text && (todo.assignee ?? null) === (op.assignee ?? null));
      return {
        ...state,
        sections: state.sections.map((item) => item.sectionId !== op.sectionId
          ? item
          : {
              ...section,
              todos: exists
                ? section.todos
                : [
                    ...section.todos,
                    {
                      text: op.text,
                      assignee: op.assignee ?? null,
                      done: false,
                      sourceRefs: op.sourceRefs ?? [],
                    },
                  ],
              sourceRefs: mergeSourceRefs(section.sourceRefs, op.sourceRefs),
            }),
      };
    }
    case "set_summary":
      return {
        ...state,
        summary: op.summary,
      };
    case "set_status":
      return {
        ...state,
        meeting: {
          ...state.meeting,
          status: op.status,
        },
      };
  }
}

export function renderMinutesMarkdown(state: MinutesState): string {
  const lines: string[] = [
    `# Meeting Minutes${state.meeting.startedAt ? ` — ${state.meeting.startedAt.slice(0, 10)}` : ""}`,
    "",
    "## Attendees",
  ];

  if (state.attendees.length === 0) {
    lines.push("_Attendees pending._");
  } else {
    for (const attendee of state.attendees) {
      const meta = [attendee.role, attendee.present === false ? "left" : null].filter(Boolean).join(", ");
      lines.push(`- ${attendee.name}${meta ? ` (${meta})` : ""}`);
    }
  }

  lines.push("", "## Topics Discussed", "");

  if (state.sections.length === 0) {
    lines.push("_No topics yet._");
  } else {
    for (const section of state.sections) {
      lines.push(`### ${section.title}`);
      for (const bullet of section.bullets) {
        lines.push(`- ${bullet}`);
      }
      for (const decision of section.decisions) {
        lines.push(`- Decision: ${decision}`);
      }
      for (const todo of section.todos) {
        const assignee = todo.assignee?.trim() ? todo.assignee.trim() : "Unassigned";
        lines.push(`- TODO(${assignee}): ${todo.text}`);
      }
      lines.push("");
    }
  }

  if (state.summary.length > 0) {
    lines.push("## Summary");
    lines.push("");
    for (const bullet of state.summary) {
      lines.push(`- ${bullet}`);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
