#!/usr/bin/env bun

import { startFromCommandLine } from "./src/main";

startFromCommandLine(Bun.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
