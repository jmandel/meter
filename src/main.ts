import path from "node:path";

import type { InternalConfig, TranscriptionProvider, WorkerLaunchConfig } from "./domain";
import { CoordinatorApp } from "./coordinator";
import { WorkerProcess } from "./worker";
import { decodeBase64Json, parseBoolean, parseInteger, randomToken } from "./utils";

function parseArgs(argv: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
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
  return entries;
}

function loadCoordinatorConfig(args: Map<string, string>): InternalConfig {
  const mode = (args.get("--mode") ?? process.env.ZOOMER_MODE ?? "all") as InternalConfig["mode"];
  const listenHost = args.get("--listen-host") ?? process.env.ZOOMER_LISTEN_HOST ?? "127.0.0.1";
  const listenPort = parseInteger(args.get("--listen-port") ?? process.env.ZOOMER_LISTEN_PORT ?? null, 3100);
  const dataRoot = path.resolve(args.get("--data-root") ?? process.env.ZOOMER_DATA_ROOT ?? path.join(process.cwd(), "data"));
  const coordinatorBaseUrl = args.get("--coordinator-base-url") ?? process.env.ZOOMER_COORDINATOR_BASE_URL ?? `http://127.0.0.1:${listenPort}`;
  const publicBaseUrl = args.get("--public-base-url") ?? process.env.ZOOMER_PUBLIC_BASE_URL ?? coordinatorBaseUrl;
  const provider = (args.get("--transcription-provider") ?? process.env.ZOOMER_TRANSCRIPTION_PROVIDER ?? "none") as TranscriptionProvider;
  return {
    mode,
    public_base_url: publicBaseUrl,
    listen_host: listenHost,
    listen_port: listenPort,
    data_root: dataRoot,
    chrome_bin: args.get("--chrome-bin") ?? process.env.CHROME_BIN ?? "/usr/bin/chromium",
    default_bot_name: args.get("--default-bot-name") ?? process.env.BOT_NAME ?? "Meeting Bot",
    transcription_provider: provider,
    persist_live_pcm: parseBoolean(args.get("--persist-live-pcm") ?? process.env.ZOOMER_PERSIST_LIVE_PCM, false),
    persist_archive_audio: parseBoolean(args.get("--persist-archive-audio") ?? process.env.ZOOMER_PERSIST_ARCHIVE_AUDIO, true),
    archive_chunk_ms: parseInteger(args.get("--archive-chunk-ms") ?? process.env.ZOOMER_ARCHIVE_CHUNK_MS ?? null, 5000),
    live_pcm_chunk_ms: parseInteger(args.get("--live-pcm-chunk-ms") ?? process.env.ZOOMER_LIVE_PCM_CHUNK_MS ?? null, 480),
    sqlite_path: path.join(dataRoot, "index.sqlite"),
    coordinator_base_url: coordinatorBaseUrl,
    coordinator_token: args.get("--coordinator-token") ?? process.env.ZOOMER_COORDINATOR_TOKEN ?? randomToken(24),
    heartbeat_interval_ms: parseInteger(args.get("--heartbeat-interval-ms") ?? process.env.ZOOMER_HEARTBEAT_INTERVAL_MS ?? null, 5000),
  };
}

export async function startFromCommandLine(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const mode = args.get("--mode") ?? process.env.ZOOMER_MODE ?? "all";

  if (mode === "worker") {
    const encoded = process.env.ZOOMER_WORKER_CONFIG_B64;
    if (!encoded) {
      throw new Error("Missing ZOOMER_WORKER_CONFIG_B64 for worker mode");
    }
    const launchConfig = decodeBase64Json<WorkerLaunchConfig>(encoded);
    const worker = new WorkerProcess(launchConfig);
    await worker.start();
    return;
  }

  if (mode !== "all" && mode !== "api") {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const config = loadCoordinatorConfig(args);
  const app = new CoordinatorApp(config);
  await app.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  await new Promise(() => {});
}
