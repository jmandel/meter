#!/usr/bin/env bun

import { runMeterCommand } from "./src/operator";

function parseArgs(argv: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  let positionalAction: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionalAction ??= value;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      entries.set(value, "true");
      continue;
    }
    entries.set(value, next);
    index += 1;
  }
  if (positionalAction && !entries.has("--action")) {
    entries.set("--action", positionalAction);
  }
  return entries;
}

runMeterCommand(parseArgs(Bun.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
