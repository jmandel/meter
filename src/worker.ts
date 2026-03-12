import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AppendEventsBatchRequest,
  AudioCaptureStartedPayload,
  AudioChunkWrittenPayload,
  BrowserConsolePayload,
  BrowserCaptureStartedMessage,
  BrowserCaptureStoppedMessage,
  BrowserControlMessage,
  BrowserDomEventMessage,
  BrowserHelloMessage,
  CompleteMeetingRunRequest,
  ErrorRaisedPayload,
  EventEnvelope,
  EventKind,
  EventSourceKind,
  MeetingLifecycleFile,
  MeetingRunState,
  TranscriptionSegmentPayload,
  WorkerHeartbeatPayload,
  WorkerLaunchConfig,
  WorkerStartedPayload,
  ZoomMeetingJoinedPayload,
} from "./domain";
import { renderBootstrapScript } from "./bootstrap";
import { CDPSession, cdpEval, cdpWaitFor, connectCDP, listTargets, waitForCDP } from "./cdp";
import { NoopTranscriptionAdapter, type TranscriptionAdapter } from "./transcription/adapter";
import { MistralRealtimeTranscriptionAdapter } from "./transcription/mistral-adapter";
import {
  appendJsonLine,
  appendLogLine,
  errorResponse,
  getAvailablePort,
  nowUnixMs,
  randomToken,
  readJsonFile,
  sleep,
  uuidv7,
  writeJsonFile,
} from "./utils";
import { writeMeetingLifecycle } from "./files";

interface RuntimePaths {
  data_dir: string;
  event_journal_path: string;
  archive_audio_dir: string;
  archive_mp3_path: string;
  live_pcm_dir: string | null;
  worker_log_path: string;
  browser_log_path: string;
  metadata_path: string;
  lifecycle_path: string;
  errors_path: string;
  archive_manifest_path: string;
  live_pcm_manifest_path: string | null;
  transcripts_provider_raw_path: string;
  transcripts_segments_path: string;
}

interface PendingEventBatch {
  first_seq: number;
  last_seq: number;
  events: EventEnvelope[];
}

interface ArchiveEncoderState {
  process: ChildProcessWithoutNullStreams | null;
  closePromise: Promise<number | null> | null;
  writeChain: Promise<void>;
  streamId: string | null;
  startedAtUnixMs: number | null;
  endedAtUnixMs: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  failed: boolean;
  emitted: boolean;
}

function isTerminalState(state: MeetingRunState): boolean {
  return state === "completed" || state === "failed" || state === "aborted";
}

function parsePcmFrame(data: ArrayBuffer | Uint8Array): {
  stream_seq: number;
  ts_unix_ms: number;
  sample_rate_hz: number;
  payload: Uint8Array;
} {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const headerLength = 28;
  if (bytes.byteLength < headerLength) {
    throw new Error("PCM frame too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = Buffer.from(bytes.slice(0, 4)).toString("ascii");
  if (magic !== "ZPCM") {
    throw new Error(`Unexpected PCM magic: ${magic}`);
  }
  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new Error(`Unexpected PCM version: ${version}`);
  }
  const stream_seq = view.getUint32(8, true);
  const ts_unix_ms = Number(view.getBigUint64(12, true));
  const sample_rate_hz = view.getUint32(20, true);
  const payload_bytes = view.getUint32(24, true);
  const payload = bytes.slice(headerLength);
  if (payload.byteLength !== payload_bytes) {
    throw new Error(`PCM payload length mismatch: expected ${payload_bytes}, got ${payload.byteLength}`);
  }
  return {
    stream_seq,
    ts_unix_ms,
    sample_rate_hz,
    payload,
  };
}

export class WorkerProcess {
  private readonly workerId = uuidv7();
  private readonly browserToken: string;
  private readonly paths: RuntimePaths;
  private seq = 1;
  private state: MeetingRunState = "starting";
  private ingestPort = 0;
  private cdpPort = 0;
  private browserConnections = 0;
  private stopping = false;
  private completionSent = false;
  private pendingEvents: EventEnvelope[] = [];
  private flushing = false;
  private browserMessageQueue = Promise.resolve();
  private currentSpeakerLabel: string | null = null;
  private archiveErrorReported = false;
  private readonly archiveEncoder: ArchiveEncoderState = {
    process: null,
    closePromise: null,
    writeChain: Promise.resolve(),
    streamId: null,
    startedAtUnixMs: null,
    endedAtUnixMs: null,
    sampleRateHz: null,
    channels: null,
    failed: false,
    emitted: false,
  };
  private chrome?: Bun.Subprocess<"ignore", "ignore", "inherit">;
  private cdp?: CDPSession;
  private heartbeatTimer?: Timer;
  private server?: Bun.Server;
  private readonly chromeUserDataDir: string;
  private readonly startedAtUnixMs = nowUnixMs();
  private endedAtUnixMs: number | null = null;
  private transcriptionAdapter: TranscriptionAdapter = new NoopTranscriptionAdapter();
  private transcriptionInitialized = false;
  private doneResolve?: () => void;
  private donePromise = new Promise<void>((resolve) => {
    this.doneResolve = resolve;
  });

  constructor(private readonly launch: WorkerLaunchConfig) {
    this.browserToken = launch.browser_token || randomToken(24);
    this.paths = {
      data_dir: launch.paths.data_dir,
      event_journal_path: launch.paths.event_journal_path,
      archive_audio_dir: launch.paths.archive_audio_dir,
      archive_mp3_path: path.join(launch.paths.archive_audio_dir, "meeting.mp3"),
      live_pcm_dir: launch.paths.live_pcm_dir,
      worker_log_path: launch.paths.worker_log_path,
      browser_log_path: launch.paths.browser_log_path,
      metadata_path: path.join(launch.paths.data_dir, "metadata.json"),
      lifecycle_path: path.join(launch.paths.data_dir, "lifecycle.json"),
      errors_path: path.join(launch.paths.data_dir, "errors.ndjson"),
      archive_manifest_path: path.join(launch.paths.archive_audio_dir, "manifest.json"),
      live_pcm_manifest_path: launch.paths.live_pcm_dir ? path.join(launch.paths.live_pcm_dir, "pcm_manifest.json") : null,
      transcripts_provider_raw_path: path.join(launch.paths.data_dir, "transcripts", "provider_raw.ndjson"),
      transcripts_segments_path: path.join(launch.paths.data_dir, "transcripts", "segments.jsonl"),
    };
    this.chromeUserDataDir = path.join(launch.paths.data_dir, "chrome-profile");
  }

  async start(): Promise<void> {
    this.ingestPort = await getAvailablePort();
    this.cdpPort = await getAvailablePort();
    await Bun.write(path.join(this.chromeUserDataDir, ".keep"), "", { createPath: true });
    await this.startLoopbackServer();
    await this.register();
    await this.writeLifecycle();

    const startedPayload: WorkerStartedPayload = {
      worker_id: this.workerId,
      pid: process.pid,
      ingest_port: this.ingestPort,
      cdp_port: this.cdpPort,
      chrome_user_data_dir: this.chromeUserDataDir,
    };
    await this.emitEvent("worker", "system.worker.started", startedPayload);
    await this.setState("joining");
    await this.emitEvent("browser", "browser.capture.bootstrap_ready", {
      bootstrap_url: `${this.workerBaseUrl()}/internal/browser/bootstrap.js?token=${this.browserToken}`,
    });

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.launch.app.heartbeat_interval_ms);

    process.on("SIGINT", () => {
      void this.complete("aborted", {
        code: "worker_sigint",
        message: "Worker received SIGINT",
        fatal: false,
      });
    });
    process.on("SIGTERM", () => {
      void this.complete("aborted", {
        code: "worker_sigterm",
        message: "Worker received SIGTERM",
        fatal: false,
      });
    });

    await this.launchBrowserAutomation();
    await this.donePromise;
  }

  private async startLoopbackServer(): Promise<void> {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.ingestPort,
      fetch: (request, server) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");

        if (url.pathname === "/internal/browser/session") {
          if (token !== this.browserToken) {
            return errorResponse(401, "unauthorized", "Invalid browser token");
          }
          const upgraded = server.upgrade(request);
          return upgraded ? undefined : errorResponse(400, "upgrade_failed", "WebSocket upgrade failed");
        }

        if (url.pathname === "/internal/browser/bootstrap.js" && request.method === "GET") {
          if (token !== this.browserToken) {
            return errorResponse(401, "unauthorized", "Invalid browser token");
          }
          const script = renderBootstrapScript({
            browser_token: this.browserToken,
            meeting_run_id: this.launch.meeting_run_id,
            room_id: this.launch.room_id,
            worker_base_url: this.workerBaseUrl(),
            open_chat_panel: this.launch.options.open_chat_panel,
          });
          return this.withBrowserCors(new Response(script, {
            headers: {
              "content-type": "application/javascript; charset=utf-8",
              "cache-control": "no-store",
            },
          }), request);
        }

        return errorResponse(404, "not_found", `No route for ${request.method} ${url.pathname}`);
      },
      websocket: {
        open: () => {
          this.browserConnections += 1;
        },
        message: (ws, message) => {
          void ws;
          this.browserMessageQueue = this.browserMessageQueue
            .then(() => this.handleBrowserSocketMessage(message))
            .catch(async (error) => {
              const messageText = error instanceof Error ? error.message : String(error);
              await this.raiseError("browser_ingest_error", messageText, false);
            });
        },
        close: () => {
          this.browserConnections = Math.max(0, this.browserConnections - 1);
        },
      },
    });
    await this.log(`loopback server listening on ${this.workerBaseUrl()}`);
  }

  private workerBaseUrl(): string {
    return `http://127.0.0.1:${this.ingestPort}`;
  }

  private browserCorsHeaders(request: Request): Headers {
    const headers = new Headers();
    headers.set("access-control-allow-origin", request.headers.get("origin") ?? "*");
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type, x-chunk-started-at, x-chunk-ended-at, x-sha256");
    headers.set("access-control-max-age", "86400");
    if (request.headers.get("access-control-request-private-network") === "true") {
      headers.set("access-control-allow-private-network", "true");
    }
    return headers;
  }

  private withBrowserCors(response: Response, request: Request): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of this.browserCorsHeaders(request).entries()) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async log(message: string): Promise<void> {
    console.log(`[worker ${this.launch.meeting_run_id}] ${message}`);
    await appendLogLine(this.paths.worker_log_path, message);
  }

  private async browserLog(message: string): Promise<void> {
    await appendLogLine(this.paths.browser_log_path, message);
  }

  private browserAutomationEnabled(): boolean {
    return process.env.ZOOMER_DISABLE_BROWSER_AUTOMATION !== "1";
  }

  private async launchBrowserAutomation(): Promise<void> {
    if (!this.browserAutomationEnabled()) {
      await this.log("browser automation disabled by ZOOMER_DISABLE_BROWSER_AUTOMATION=1");
      return;
    }
    try {
      await this.launchChromeProcess();
      await waitForCDP(this.cdpPort);

      const targets = await listTargets(this.cdpPort);
      const pageTarget = targets.find((target) => target.type === "page");
      if (!pageTarget) {
        throw new Error("No Chromium page target was available");
      }

      const cdp = await connectCDP(this.cdpPort, pageTarget.id);
      this.cdp = cdp;
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");

      cdp.on("Runtime.consoleAPICalled", (params: any) => {
        const text = (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" ").trim();
        if (!text) {
          return;
        }
        const level = this.mapConsoleLevel(params.type);
        const payload: BrowserConsolePayload = {
          level,
          text,
        };
        void this.browserLog(`[${level}] ${text}`);
        void this.emitEvent("browser", "browser.console", payload, params);
      });

      cdp.on("Page.javascriptDialogOpening", () => {
        void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
      });

      const origin = new URL(this.launch.normalized_join_url).origin;
      await cdp.send("Browser.grantPermissions", {
        origin,
        permissions: ["audioCapture", "videoCapture", "displayCapture", "notifications"],
      }).catch(() => undefined);

      await this.navigateAndJoin(cdp);
      await this.injectCaptureBootstrap(cdp);
    } catch (error) {
      if (this.completionSent || this.stopping) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.raiseError("browser_join_failed", message, true, {
        join_url: this.launch.normalized_join_url,
      });
    }
  }

  private async launchChromeProcess(): Promise<void> {
    if (this.chrome) {
      return;
    }
    const chromeArgs = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.chromeUserDataDir}`,
      "--auto-select-desktop-capture-source=Zoom",
      "--auto-accept-this-tab-capture",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-popup-blocking",
      "--disable-translate",
      "--disable-infobars",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-external-intent-requests",
      "--enable-features=SharedArrayBuffer",
      "--disable-features=ExternalProtocolDialog",
      "--window-size=1280,960",
      "about:blank",
    ];
    this.chrome = Bun.spawn([this.launch.app.chrome_bin, ...chromeArgs], {
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
      },
    });
    await this.log(`launched chromium cdp_port=${this.cdpPort}`);
    void this.chrome.exited.then(async (code) => {
      if (this.completionSent || this.stopping) {
        return;
      }
      await this.raiseError("chrome_exit", `Chromium exited with code ${code}`, true);
    });
  }

  private mapConsoleLevel(value: string): BrowserConsolePayload["level"] {
    if (value === "warning") {
      return "warn";
    }
    if (value === "error") {
      return "error";
    }
    if (value === "debug") {
      return "debug";
    }
    return "info";
  }

  private async navigateAndJoin(cdp: CDPSession): Promise<void> {
    await this.log(`navigating to ${this.launch.normalized_join_url}`);
    const loadPromise = new Promise<void>((resolve) => {
      cdp.on("Page.loadEventFired", () => resolve());
    });
    await cdp.send("Page.navigate", { url: this.launch.normalized_join_url });
    await loadPromise;
    await sleep(2000);

    await this.tryClickBrowserJoinFallback(cdp);
    await cdpWaitFor(
      cdp,
      `(() => !!document.getElementById("input-for-name") || !!document.getElementById("meeting-app"))()`,
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    const hasMeetingApp = await cdpEval(cdp, `!!document.getElementById("meeting-app")`);
    if (!hasMeetingApp) {
      await this.prepareJoinForm(cdp);
    }

    await this.waitForMeetingShell(cdp);
  }

  private async tryClickBrowserJoinFallback(cdp: CDPSession): Promise<void> {
    await cdpEval(
      cdp,
      `(() => {
        const candidates = Array.from(document.querySelectorAll("button, a"));
        const target = candidates.find((element) => /join from (your )?browser/i.test((element.textContent || "").trim()));
        if (target) {
          target.click();
          return true;
        }
        return false;
      })()`,
    ).catch(() => false);
    await sleep(1000);
  }

  private async prepareJoinForm(cdp: CDPSession): Promise<void> {
    await cdpWaitFor(cdp, `!!document.getElementById("input-for-name")`, {
      timeoutMs: 30_000,
      intervalMs: 500,
    });

    await cdpEval(
      cdp,
      `(() => {
        const buttons = [
          document.getElementById("preview-audio-control-button"),
          document.getElementById("preview-video-control-button"),
        ].filter(Boolean);
        for (const button of buttons) {
          const label = (button.textContent || button.getAttribute("aria-label") || "").trim().toLowerCase();
          if (!label.includes("unmute") && !label.includes("start video")) {
            button.click();
          }
        }
        return true;
      })()`,
    );

    await cdpEval(
      cdp,
      `(() => {
        const input = document.getElementById("input-for-name");
        if (!input) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        descriptor.set.call(input, ${JSON.stringify(this.launch.bot_name)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    );
    await sleep(500);

    await cdpWaitFor(
      cdp,
      `(() => {
        const button = document.querySelector(".preview-join-button");
        return button && !button.classList.contains("zm-btn--disabled");
      })()`,
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    await cdpEval(cdp, `document.querySelector(".preview-join-button")?.click()`);
    await this.browserLog("submitted zoom join form");
  }

  private async waitForMeetingShell(cdp: CDPSession): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.dismissDialogs(cdp);
      const hasMeetingShell = await cdpEval(cdp, `!!document.getElementById("meeting-app")`);
      if (hasMeetingShell) {
        await this.browserLog("meeting shell detected");
        return;
      }
      await sleep(3000);
    }
    await this.browserLog("meeting shell not detected; proceeding with capture bootstrap");
  }

  private async dismissDialogs(cdp: CDPSession): Promise<void> {
    await cdpEval(
      cdp,
      `(() => {
        for (const button of Array.from(document.querySelectorAll("button"))) {
          const label = (button.textContent || button.getAttribute("aria-label") || "").trim();
          if (["OK", "Got it", "Got It", "Close", "Dismiss", "Not Now", "Maybe Later", "Skip"].includes(label)) {
            button.click();
          }
        }
        return true;
      })()`,
    ).catch(() => undefined);
  }

  private async injectCaptureBootstrap(cdp: CDPSession): Promise<void> {
    await this.browserLog("injecting browser capture bootstrap");
    await cdpEval(
      cdp,
      renderBootstrapScript({
        browser_token: this.browserToken,
        meeting_run_id: this.launch.meeting_run_id,
        room_id: this.launch.room_id,
        worker_base_url: this.workerBaseUrl(),
        open_chat_panel: this.launch.options.open_chat_panel,
      }),
    );
    await cdpEval(cdp, `window.__zoomerCapture.installCaptureButton()`);
    const clickPoint = await cdpWaitFor(
      cdp,
      `(() => {
        const buttonId = window.__zoomerCapture && window.__zoomerCapture.buttonId;
        const button = buttonId ? document.getElementById(buttonId) : null;
        if (!button) {
          return null;
        }
        const rect = button.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()`,
      { timeoutMs: 10_000, intervalMs: 250 },
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickPoint.x,
      y: clickPoint.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickPoint.x,
      y: clickPoint.y,
      button: "left",
      clickCount: 1,
    });

    const captureState = await cdpWaitFor(
      cdp,
      `(() => {
        if (!window.__zoomerCapture) {
          return null;
        }
        const phase = window.__zoomerCapture.state.phase;
        if (phase === "streaming" || phase === "error") {
          return {
            phase,
            error: window.__zoomerCapture.state.error,
          };
        }
        return null;
      })()`,
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    if (captureState.phase === "error") {
      throw new Error(captureState.error || "Browser capture bootstrap failed");
    }
    await this.browserLog("browser capture bootstrap is streaming");
  }

  private async clickVisibleBrowserButton(cdp: CDPSession, patterns: string[]): Promise<string | null> {
    return await cdpEval(
      cdp,
      `(() => {
        const patterns = ${JSON.stringify(patterns)};
        const candidates = Array.from(document.querySelectorAll("button,[role=button],a"));
        for (const element of candidates) {
          if (!(element instanceof HTMLElement) || element.offsetParent === null) {
            continue;
          }
          const label = (element.getAttribute("aria-label") || element.textContent || "").trim();
          if (!label) {
            continue;
          }
          if (patterns.some((pattern) => new RegExp(pattern, "i").test(label))) {
            element.click();
            return label;
          }
        }
        return null;
      })()`,
    );
  }

  private async attemptGracefulLeave(): Promise<void> {
    if (!this.cdp) {
      return;
    }

    try {
      const leaveLabel = await this.clickVisibleBrowserButton(this.cdp, ["^leave$"]);
      if (!leaveLabel) {
        await this.browserLog("graceful leave skipped; leave button not found");
        return;
      }
      await this.browserLog(`clicked ${leaveLabel}`);

      const confirmedLabel = await cdpWaitFor(
        this.cdp,
        `(() => {
          const patterns = [/leave meeting/i, /end meeting for all/i, /^end$/i];
          const candidates = Array.from(document.querySelectorAll("button,[role=button],a"));
          for (const element of candidates) {
            if (!(element instanceof HTMLElement) || element.offsetParent === null) {
              continue;
            }
            const label = (element.getAttribute("aria-label") || element.textContent || "").trim();
            if (!label) {
              continue;
            }
            if (patterns.some((pattern) => pattern.test(label))) {
              element.click();
              return label;
            }
          }
          return null;
        })()`,
        { timeoutMs: 3_000, intervalMs: 200 },
      );
      await this.browserLog(`confirmed graceful leave with ${confirmedLabel}`);
      await sleep(500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.browserLog(`graceful leave failed: ${message}`);
    }
  }

  private async stopChrome(): Promise<void> {
    try {
      this.cdp?.close();
    } catch {
      // ignore best-effort cleanup
    }
    this.cdp = undefined;
    const chrome = this.chrome;
    this.chrome = undefined;
    if (!chrome) {
      return;
    }
    try {
      chrome.kill("SIGTERM");
    } catch {
      return;
    }
    await Promise.race([
      chrome.exited,
      sleep(1500),
    ]);
  }

  private getTranscriptionAdapter(): TranscriptionAdapter {
    if (this.transcriptionInitialized) {
      return this.transcriptionAdapter;
    }
    this.transcriptionInitialized = true;

    if (!this.launch.options.enable_transcription) {
      return this.transcriptionAdapter;
    }

    if (this.launch.app.transcription_provider !== "mistral") {
      void this.raiseError(
        "transcription_provider_unsupported",
        `Transcription provider ${this.launch.app.transcription_provider} is not implemented`,
        false,
      );
      return this.transcriptionAdapter;
    }

    const apiKey = process.env.MISTRAL_API_KEY || "";
    if (!apiKey) {
      void this.raiseError(
        "mistral_api_key_missing",
        "MISTRAL_API_KEY is required for realtime transcription",
        false,
      );
      return this.transcriptionAdapter;
    }

    this.transcriptionAdapter = new MistralRealtimeTranscriptionAdapter({
      apiKey,
      meetingRunId: this.launch.meeting_run_id,
      roomId: this.launch.room_id,
      providerRawPath: this.paths.transcripts_provider_raw_path,
      segmentsPath: this.paths.transcripts_segments_path,
      callbacks: {
        emitEvent: (source, kind, payload, raw, tsUnixMs) =>
          this.emitEvent(source, kind, this.withCurrentSpeaker(kind, payload), raw, tsUnixMs),
        appendProviderRaw: async () => {},
        appendSegment: async () => {},
        raiseError: (error) => this.raiseError(error.code, error.message, error.fatal, error.details),
        log: (message) => this.log(`[transcription] ${message}`),
      },
    });
    return this.transcriptionAdapter;
  }

  private async writeLifecycle(lastError?: ErrorRaisedPayload | null): Promise<void> {
    const lifecycle: MeetingLifecycleFile = {
      meeting_run_id: this.launch.meeting_run_id,
      state: this.state,
      worker_id: this.workerId,
      worker_pid: process.pid,
      ingest_port: this.ingestPort,
      cdp_port: this.cdpPort,
      started_at_unix_ms: this.startedAtUnixMs,
      ended_at_unix_ms: this.endedAtUnixMs,
      updated_at_unix_ms: nowUnixMs(),
      last_error: lastError
        ? {
            code: lastError.code,
            message: lastError.message,
            details: lastError.details,
          }
        : null,
    };
    await writeMeetingLifecycle(
      {
        data_dir: this.paths.data_dir,
        event_journal_path: this.paths.event_journal_path,
        archive_audio_dir: this.paths.archive_audio_dir,
        live_pcm_dir: this.paths.live_pcm_dir,
        worker_log_path: this.paths.worker_log_path,
        browser_log_path: this.paths.browser_log_path,
        metadata_path: this.paths.metadata_path,
        lifecycle_path: this.paths.lifecycle_path,
        errors_path: this.paths.errors_path,
        transcripts_dir: path.join(this.paths.data_dir, "transcripts"),
        transcripts_provider_raw_path: path.join(this.paths.data_dir, "transcripts", "provider_raw.ndjson"),
        transcripts_segments_path: path.join(this.paths.data_dir, "transcripts", "segments.jsonl"),
        archive_manifest_path: this.paths.archive_manifest_path,
        live_pcm_manifest_path: this.paths.live_pcm_manifest_path,
        artifacts_dir: path.join(this.paths.data_dir, "artifacts"),
        dom_artifacts_dir: path.join(this.paths.data_dir, "artifacts", "dom"),
        screenshots_dir: path.join(this.paths.data_dir, "artifacts", "screenshots"),
      },
      lifecycle,
    );
  }

  private async setState(state: MeetingRunState, lastError?: ErrorRaisedPayload): Promise<void> {
    this.state = state;
    await this.writeLifecycle(lastError ?? null);
  }

  private async register(): Promise<void> {
    const response = await fetch(`${this.launch.app.coordinator_base_url}/internal/v1/workers/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.launch.app.coordinator_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        worker_id: this.workerId,
        meeting_run_id: this.launch.meeting_run_id,
        pid: process.pid,
        ingest_port: this.ingestPort,
        cdp_port: this.cdpPort,
        started_at_unix_ms: nowUnixMs(),
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to register worker: ${response.status} ${await response.text()}`);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.completionSent) {
      return;
    }
    const ts = nowUnixMs();
    const payload: WorkerHeartbeatPayload = {
      worker_id: this.workerId,
      state: this.state,
      rss_bytes: process.memoryUsage().rss,
      open_ws_connections: this.browserConnections,
    };
    await this.emitEvent("worker", "system.worker.heartbeat", payload);
    const response = await fetch(`${this.launch.app.coordinator_base_url}/internal/v1/workers/${this.workerId}/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.launch.app.coordinator_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        meeting_run_id: this.launch.meeting_run_id,
        state: this.state,
        ts_unix_ms: ts,
        rss_bytes: payload.rss_bytes,
        open_ws_connections: payload.open_ws_connections,
      }),
    });
    if (!response.ok) {
      await this.log(`heartbeat failed: ${response.status}`);
      return;
    }
    const body = await response.json();
    if (body.stop_requested && !this.stopping) {
      await this.log("stop requested by coordinator");
      await this.complete("completed");
    }
  }

  private async emitEvent(
    source: EventSourceKind,
    kind: EventKind,
    payload: unknown,
    raw?: unknown,
    tsUnixMs = nowUnixMs(),
  ): Promise<void> {
    const event: EventEnvelope = {
      meeting_run_id: this.launch.meeting_run_id,
      room_id: this.launch.room_id,
      seq: this.seq,
      source,
      kind,
      ts_unix_ms: tsUnixMs,
      payload,
      raw,
    };
    this.seq += 1;
    await appendJsonLine(this.paths.event_journal_path, event);
    if (kind === "error.raised") {
      await appendJsonLine(this.paths.errors_path, event);
    }
    this.pendingEvents.push(event);
    await this.flushEvents();
  }

  private async flushEvents(): Promise<void> {
    if (this.flushing || this.pendingEvents.length === 0) {
      return;
    }
    this.flushing = true;
    while (this.pendingEvents.length > 0) {
      const events = [...this.pendingEvents];
      const batch: AppendEventsBatchRequest = {
        worker_id: this.workerId,
        first_seq: events[0].seq,
        last_seq: events[events.length - 1].seq,
        events,
      };
      const response = await fetch(`${this.launch.app.coordinator_base_url}/internal/v1/meeting-runs/${this.launch.meeting_run_id}/events:batch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.launch.app.coordinator_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
      }).catch((error) => error);

      if (response instanceof Error) {
        await this.log(`event flush failed: ${response.message}`);
        await sleep(1000);
        continue;
      }
      if (!response.ok) {
        await this.log(`event flush failed with ${response.status}`);
        await sleep(1000);
        continue;
      }
      this.pendingEvents.splice(0, events.length);
    }
    this.flushing = false;
  }

  private async raiseError(code: string, message: string, fatal: boolean, details?: Record<string, unknown>): Promise<void> {
    const errorPayload: ErrorRaisedPayload = {
      code,
      message,
      fatal,
      details,
    };
    await this.emitEvent("worker", "error.raised", errorPayload);
    await this.log(`error ${code}: ${message}`);
    if (fatal) {
      await this.complete("failed", errorPayload);
    }
  }

  private async handleBrowserSocketMessage(message: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    try {
      if (typeof message === "string") {
        const parsed = JSON.parse(message) as BrowserControlMessage;
        await this.handleBrowserControlMessage(parsed);
        return;
      }
      const bytes = message instanceof Uint8Array ? message : message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      await this.handlePcmFrame(bytes);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.raiseError("browser_ingest_error", messageText, false);
    }
  }

  private async handleBrowserControlMessage(message: BrowserControlMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        await this.handleHello(message);
        break;
      case "capture.started":
        await this.handleCaptureStarted(message);
        break;
      case "capture.stopped":
        await this.handleCaptureStopped(message);
        break;
      case "dom.event":
        await this.handleDomEvent(message);
        break;
      case "archive.flush":
        await this.handleArchiveFlush(message);
        break;
      default:
        await this.raiseError("unknown_browser_message", `Unsupported browser message type ${(message as { type?: string }).type ?? "unknown"}`, false);
        break;
    }
  }

  private async handleHello(message: BrowserHelloMessage): Promise<void> {
    await this.browserLog(`hello ${message.page_url}`);
    await this.emitEvent("browser", "browser.page.loaded", {
      page_url: message.page_url,
      user_agent: message.user_agent,
    }, message, message.ts_unix_ms);
    const joinedPayload: ZoomMeetingJoinedPayload = {
      title: null,
      page_url: message.page_url,
      joined_at_unix_ms: message.ts_unix_ms,
    };
    await this.emitEvent("zoom_dom", "zoom.meeting.joined", joinedPayload, message, message.ts_unix_ms);
  }

  private async handleCaptureStarted(message: BrowserCaptureStartedMessage): Promise<void> {
    const payload: AudioCaptureStartedPayload = {
      archive_stream_id: message.archive_stream_id,
      live_stream_id: message.live_stream_id,
      archive_content_type: message.archive_content_type,
      archive_codec: message.archive_codec,
      pcm_sample_rate_hz: message.pcm_sample_rate_hz,
      pcm_channels: message.pcm_channels,
    };
    await this.setState("capturing");
    await this.browserLog(`capture started archive=${message.archive_stream_id} live=${message.live_stream_id}`);
    await this.emitEvent("audio_capture", "audio.capture.started", payload, message, message.ts_unix_ms);
    await this.getTranscriptionAdapter().start(payload);
  }

  private async handleCaptureStopped(message: BrowserCaptureStoppedMessage): Promise<void> {
    await this.browserLog(`capture stopped reason=${message.reason}`);
    await this.emitEvent("audio_capture", "audio.capture.stopped", {
      reason: message.reason,
    }, message, message.ts_unix_ms);
    await this.getTranscriptionAdapter().stop(message.reason);
    if (this.launch.options.auto_stop_when_meeting_ends) {
      await this.complete("completed");
    }
  }

  private async handleDomEvent(message: BrowserDomEventMessage): Promise<void> {
    const event = message.event;
    if (event.kind === "zoom.speaker.active") {
      const speaker = (event.payload as { speaker_display_name?: string | null }).speaker_display_name;
      this.currentSpeakerLabel = typeof speaker === "string" && speaker.trim() ? speaker.trim() : null;
    }
    await this.browserLog(`dom event ${event.kind}`);
    await this.emitEvent(event.source, event.kind, event.payload, message, event.ts_unix_ms);
  }

  private withCurrentSpeaker(kind: EventKind, payload: unknown): unknown {
    if ((kind !== "transcription.segment.partial" && kind !== "transcription.segment.final") || !payload || typeof payload !== "object") {
      return payload;
    }
    const segment = payload as TranscriptionSegmentPayload;
    if (segment.speaker_label || !this.currentSpeakerLabel) {
      return payload;
    }
    return {
      ...segment,
      speaker_label: this.currentSpeakerLabel,
    } satisfies TranscriptionSegmentPayload;
  }

  private async handleArchiveFlush(message: BrowserUploadAckRequest): Promise<void> {
    await this.browserLog(`archive flush stream=${message.archive_stream_id} seq=${message.highest_chunk_seq}`);
  }

  private async handleArchiveUpload(request: Request, archiveStreamId: string, chunkSeq: number): Promise<Response> {
    if (!this.launch.options.persist_archive_audio) {
      return errorResponse(409, "archive_disabled", "Archive audio persistence is disabled");
    }

    const contentType = getRequiredHeader(request, "content-type");
    const startedAt = Number.parseInt(getRequiredHeader(request, "x-chunk-started-at"), 10);
    const endedAt = Number.parseInt(getRequiredHeader(request, "x-chunk-ended-at"), 10);
    const shaHeader = getRequiredHeader(request, "x-sha256");
    const bytes = new Uint8Array(await request.arrayBuffer());
    const computedSha = await sha256Hex(bytes);
    if (computedSha !== shaHeader) {
      return errorResponse(400, "sha_mismatch", "Archive chunk digest mismatch");
    }

    const filePath = path.join(this.paths.archive_audio_dir, `${String(chunkSeq).padStart(6, "0")}.webm`);
    await Bun.write(filePath, bytes, { createPath: true });

    const manifest = (await readJsonFile<{ chunks: Array<Record<string, unknown>> }>(this.paths.archive_manifest_path)) ?? { chunks: [] };
    const audioObjectId = uuidv7(endedAt);
    manifest.chunks.push({
      audio_object_id: audioObjectId,
      archive_stream_id: archiveStreamId,
      chunk_seq: chunkSeq,
      path: filePath,
      byte_length: bytes.byteLength,
      started_at_unix_ms: startedAt,
      ended_at_unix_ms: endedAt,
      sha256_hex: computedSha,
    });
    await writeJsonFile(this.paths.archive_manifest_path, manifest);

    const payload: AudioChunkWrittenPayload = {
      audio_object_id: audioObjectId,
      stream_kind: "archive",
      stream_id: archiveStreamId,
      path: filePath,
      chunk_seq: chunkSeq,
      byte_length: bytes.byteLength,
      content_type: contentType,
      codec: contentType.includes("codecs=") ? contentType.split("codecs=")[1] : null,
      started_at_unix_ms: startedAt,
      ended_at_unix_ms: endedAt,
      sha256_hex: computedSha,
    };
    await this.emitEvent("audio_capture", "audio.archive.chunk_written", payload, undefined, endedAt);

    const response: ArchiveChunkUploadResponse = {
      accepted: true,
      audio_object_id: audioObjectId,
      path: filePath,
      byte_length: bytes.byteLength,
    };
    return jsonResponse(response);
  }

  private async handlePcmFrame(bytes: Uint8Array): Promise<void> {
    const frame = parsePcmFrame(bytes);
    if (!this.launch.options.persist_live_pcm || !this.paths.live_pcm_dir) {
      await this.getTranscriptionAdapter().pushFrame(frame);
      return;
    }

    const filePath = path.join(this.paths.live_pcm_dir, `${String(frame.stream_seq).padStart(6, "0")}.pcm`);
    await Bun.write(filePath, frame.payload, { createPath: true });
    const sampleCount = frame.payload.byteLength / 2;
    const endedAt = frame.ts_unix_ms + Math.round((sampleCount / frame.sample_rate_hz) * 1000);
    const manifest = this.paths.live_pcm_manifest_path
      ? (await readJsonFile<{ chunks: Array<Record<string, unknown>> }>(this.paths.live_pcm_manifest_path)) ?? { chunks: [] }
      : null;
    const audioObjectId = uuidv7(frame.ts_unix_ms);
    if (manifest && this.paths.live_pcm_manifest_path) {
      manifest.chunks.push({
        audio_object_id: audioObjectId,
        chunk_seq: frame.stream_seq,
        path: filePath,
        byte_length: frame.payload.byteLength,
        started_at_unix_ms: frame.ts_unix_ms,
        ended_at_unix_ms: endedAt,
      });
      await writeJsonFile(this.paths.live_pcm_manifest_path, manifest);
    }
    const payload: AudioChunkWrittenPayload = {
      audio_object_id: audioObjectId,
      stream_kind: "live_pcm",
      stream_id: "pcm",
      path: filePath,
      chunk_seq: frame.stream_seq,
      byte_length: frame.payload.byteLength,
      content_type: "audio/pcm",
      codec: "pcm_s16le",
      started_at_unix_ms: frame.ts_unix_ms,
      ended_at_unix_ms: endedAt,
      sha256_hex: null,
    };
    await this.emitEvent("audio_capture", "audio.live_pcm.chunk_written", payload, undefined, endedAt);
    await this.getTranscriptionAdapter().pushFrame(frame);
  }

  async complete(finalState: "completed" | "failed" | "aborted", error?: ErrorRaisedPayload): Promise<void> {
    if (this.completionSent) {
      return;
    }
    this.completionSent = true;
    this.stopping = true;
    await this.getTranscriptionAdapter().stop(finalState);
    if (!isTerminalState(this.state)) {
      await this.setState(finalState === "completed" ? "stopping" : finalState, error);
    }
    await this.flushEvents();
    const endedAtUnixMs = nowUnixMs();
    this.endedAtUnixMs = endedAtUnixMs;
    const requestBody: CompleteMeetingRunRequest = {
      worker_id: this.workerId,
      final_state: finalState,
      ended_at_unix_ms: endedAtUnixMs,
      error,
    };
    const response = await fetch(`${this.launch.app.coordinator_base_url}/internal/v1/meeting-runs/${this.launch.meeting_run_id}/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.launch.app.coordinator_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      await this.log(`completion request failed: ${response.status}`);
    }

    this.state = finalState;
    await this.writeLifecycle(error ?? null);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await this.attemptGracefulLeave();
    await this.log(`completed with state=${finalState}`);
    await this.stopChrome();
    this.server?.stop();
    this.doneResolve?.();
  }
}
