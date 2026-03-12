export type SimulationAction =
  | "join"
  | "capture.start"
  | "capture.stop"
  | "attendee.join"
  | "attendee.leave"
  | "speaker"
  | "say"
  | "chat"
  | "console"
  | "event"
  | "end";

export interface SimulationScenario {
  meeting_id: string;
  title: string | null;
  bot_name: string | null;
  requested_by: string | null;
  speed: number;
  tags: string[];
  steps: SimulationStep[];
}

export interface SimulationStep {
  line: number;
  delay_ms: number;
  action: SimulationAction;
  args: Record<string, string>;
}

const ACTIONS = new Set<SimulationAction>([
  "join",
  "capture.start",
  "capture.stop",
  "attendee.join",
  "attendee.leave",
  "speaker",
  "say",
  "chat",
  "console",
  "event",
  "end",
]);

function parseScalarValue(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
      .replace(/\\\\/g, "\\")
      .replace(/\\'/g, "'");
  }
  return value;
}

function parseArgs(raw: string, line: number): Record<string, string> {
  const args: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    args[match[1]] = parseScalarValue(match[2]);
  }
  const remainder = raw.replace(pattern, "").trim();
  if (remainder) {
    throw new Error(`Invalid simulation args on line ${line}: ${remainder}`);
  }
  return args;
}

export function parseSimulationDurationMs(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${raw}`);
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid duration: ${raw}`);
  }
  switch (match[2]) {
    case "ms":
      return Math.round(value);
    case "s":
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    default:
      throw new Error(`Invalid duration unit: ${raw}`);
  }
}

export function parseSimulationScript(script: string): SimulationScenario {
  const scenario: SimulationScenario = {
    meeting_id: "",
    title: null,
    bot_name: null,
    requested_by: null,
    speed: 1,
    tags: [],
    steps: [],
  };

  for (const [index, originalLine] of script.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("+")) {
      const match = line.match(/^\+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) {
        throw new Error(`Invalid simulation step on line ${lineNumber}: ${line}`);
      }
      const action = match[2] as SimulationAction;
      if (!ACTIONS.has(action)) {
        throw new Error(`Unsupported simulation action on line ${lineNumber}: ${action}`);
      }
      scenario.steps.push({
        line: lineNumber,
        delay_ms: parseSimulationDurationMs(match[1]),
        action,
        args: parseArgs(match[3] ?? "", lineNumber),
      });
      continue;
    }

    const directiveMatch = line.match(/^([A-Za-z_][\w.-]*)\s+(.+)$/);
    if (!directiveMatch) {
      throw new Error(`Invalid simulation directive on line ${lineNumber}: ${line}`);
    }
    const directive = directiveMatch[1].toLowerCase();
    const value = parseScalarValue(directiveMatch[2]);
    if (directive === "meeting" || directive === "meeting_id") {
      scenario.meeting_id = value;
      continue;
    }
    if (directive === "title") {
      scenario.title = value;
      continue;
    }
    if (directive === "bot" || directive === "bot_name") {
      scenario.bot_name = value;
      continue;
    }
    if (directive === "requested_by") {
      scenario.requested_by = value;
      continue;
    }
    if (directive === "speed") {
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid speed on line ${lineNumber}: ${value}`);
      }
      scenario.speed = parsed;
      continue;
    }
    if (directive === "tag") {
      scenario.tags.push(value);
      continue;
    }
    throw new Error(`Unsupported simulation directive on line ${lineNumber}: ${directive}`);
  }

  if (!scenario.meeting_id) {
    throw new Error("Simulation script must include `meeting <meeting-id>`");
  }
  return scenario;
}
