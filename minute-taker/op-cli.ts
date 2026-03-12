#!/usr/bin/env bun

import { existsSync } from "node:fs";
import process from "node:process";

import { ZodError } from "zod";

import {
  applyMinutesOperation,
  formatZodError,
  getMinutesStorePaths,
  loadMinutesState,
} from "./store";

function parseArgs(argv: string[]): { command: string | null; args: Map<string, string> } {
  const args = new Map<string, string>();
  let command: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") && command === null) {
      command = value;
      continue;
    }
    if (!value.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(value, "true");
      continue;
    }
    args.set(value, next);
    index += 1;
  }
  return { command, args };
}

async function readStdinIfPresent(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.trim();
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  minute-op submit --run-dir <dir> [--json '<op-json>']");
  console.error("  minute-op show-state --run-dir <dir>");
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(Bun.argv.slice(2));
  const runDir = args.get("--run-dir");
  if (!command || !runDir) {
    printUsage();
    process.exit(1);
  }

  try {
    if (command === "submit") {
      const payloadText = args.get("--json") ?? (await readStdinIfPresent());
      if (!payloadText) {
        throw new Error("submit requires JSON via --json or stdin");
      }
      const payload = JSON.parse(payloadText);
      const result = applyMinutesOperation(runDir, payload);
      console.log(JSON.stringify({
        ok: true,
        operation: result.operation.op,
        state_path: result.paths.statePath,
        ops_path: result.paths.opsPath,
        markdown_path: result.paths.markdownPath,
        section_count: result.state.sections.length,
      }, null, 2));
      return;
    }

    if (command === "show-state") {
      const paths = getMinutesStorePaths(runDir);
      if (!existsSync(paths.statePath)) {
        throw new Error(`No minutes state found at ${paths.statePath}`);
      }
      console.log(JSON.stringify(loadMinutesState(runDir), null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof ZodError) {
      console.error(formatZodError(error));
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
