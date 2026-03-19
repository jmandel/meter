import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AppendEventsBatchRequest,
  ArtifactWrittenPayload,
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
  WorkerHeartbeatResponse,
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
  screenshots_dir: string;
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

const PERIODIC_SCREENSHOT_INTERVAL_MS = 60_000;
const PERIODIC_SCREENSHOT_JPEG_QUALITY = 25;

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

export function buildChromeArgs(options: {
  cdpPort: number;
  chromeUserDataDir: string;
}): string[] {
  return [
    `--remote-debugging-port=${options.cdpPort}`,
    `--user-data-dir=${options.chromeUserDataDir}`,
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
  private browserCaptureExpected = false;
  private captureRecoveryInFlight = false;
  private transcriptionSessionActive = false;
  private lastTranscriptionActivityAtUnixMs = 0;
  private lastTranscriptionReconnectAtUnixMs = 0;
  private lastCaptureStartedPayload: AudioCaptureStartedPayload | null = null;
  private stopping = false;
  private completionSent = false;
  private pendingEvents: EventEnvelope[] = [];
  private flushing = false;
  private browserMessageQueue = Promise.resolve();
  private currentSpeakerLabel: string | null = null;
  private operatorAssistanceClaimed = false;
  private operatorAssistanceOperator: string | null = null;
  private operatorAssistanceReason: string | null = null;
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
  private captureHealthTimer?: Timer;
  private periodicScreenshotTimer?: Timer;
  private server?: Bun.Server;
  private readonly chromeUserDataDir: string;
  private readonly startedAtUnixMs = nowUnixMs();
  private endedAtUnixMs: number | null = null;
  private transcriptionAdapter: TranscriptionAdapter = new NoopTranscriptionAdapter();
  private transcriptionInitialized = false;
  private screenshotSeq = 1;
  private screenshotCaptureInFlight = false;
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
      screenshots_dir: path.join(launch.paths.data_dir, "artifacts", "screenshots"),
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
    return process.env.METER_DISABLE_BROWSER_AUTOMATION !== "1";
  }

  private async launchBrowserAutomation(): Promise<void> {
    if (!this.browserAutomationEnabled()) {
      await this.log("browser automation disabled by METER_DISABLE_BROWSER_AUTOMATION=1");
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

    cdp.on("Page.loadEventFired", () => {
      void sleep(1000)
        .then(() => this.monitorCaptureHealth())
        .catch(() => undefined);
    });

      const origin = new URL(this.launch.normalized_join_url).origin;
      await cdp.send("Browser.grantPermissions", {
        origin,
        permissions: ["audioCapture", "videoCapture", "displayCapture", "notifications"],
      }).catch(() => undefined);

      await this.waitForOperatorRelease("navigate_and_join");
      await this.navigateAndJoin(cdp);
      await this.waitForOperatorRelease("inject_capture_bootstrap");
      await this.injectCaptureBootstrap(cdp);
      this.startCaptureHealthMonitor();
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
    const chromeArgs = buildChromeArgs({
      cdpPort: this.cdpPort,
      chromeUserDataDir: this.chromeUserDataDir,
    });
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

    await this.waitForOperatorRelease("prepare_join_form");
    const hasMeetingApp = await cdpEval(cdp, `!!document.getElementById("meeting-app")`);
    if (!hasMeetingApp) {
      await this.prepareJoinForm(cdp);
    }

    await this.waitForOperatorRelease("wait_for_meeting_shell");
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
      await this.waitForOperatorRelease("wait_for_meeting_shell");
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
    await cdpEval(cdp, `window.__meterCapture.installCaptureButton()`);
    const clickPoint = await cdpWaitFor(
      cdp,
      `(() => {
        const buttonId = window.__meterCapture && window.__meterCapture.buttonId;
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
        if (!window.__meterCapture) {
          return null;
        }
        const phase = window.__meterCapture.state.phase;
        if (phase === "streaming" || phase === "error") {
          return {
            phase,
            error: window.__meterCapture.state.error,
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

  private startCaptureHealthMonitor(): void {
    if (this.captureHealthTimer) {
      return;
    }
    this.captureHealthTimer = setInterval(() => {
      void this.monitorCaptureHealth();
    }, 5000);
  }

  private startPeriodicScreenshotCapture(): void {
    if (this.periodicScreenshotTimer) {
      return;
    }
    this.periodicScreenshotTimer = setInterval(() => {
      void this.capturePeriodicScreenshot();
    }, PERIODIC_SCREENSHOT_INTERVAL_MS);
  }

  private async capturePeriodicScreenshot(): Promise<void> {
    if (this.screenshotCaptureInFlight || !this.cdp || this.stopping || this.state !== "capturing") {
      return;
    }
    this.screenshotCaptureInFlight = true;
    try {
      const screenshot = await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: PERIODIC_SCREENSHOT_JPEG_QUALITY,
      }) as { data?: string };
      if (!screenshot?.data) {
        throw new Error("CDP did not return screenshot data");
      }
      const createdAtUnixMs = nowUnixMs();
      const artifactId = uuidv7(createdAtUnixMs);
      const filePath = path.join(this.paths.screenshots_dir, `${String(this.screenshotSeq).padStart(6, "0")}.jpg`);
      this.screenshotSeq += 1;
      const bytes = Buffer.from(screenshot.data, "base64");
      await Bun.write(filePath, bytes, { createPath: true });
      const payload: ArtifactWrittenPayload = {
        artifact_id: artifactId,
        kind: "screenshot",
        path: filePath,
        content_type: "image/jpeg",
        byte_length: bytes.byteLength,
      };
      await this.emitEvent("browser", "artifact.written", payload, undefined, createdAtUnixMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.browserLog(`periodic screenshot capture failed: ${message}`);
    } finally {
      this.screenshotCaptureInFlight = false;
    }
  }

  private async monitorCaptureHealth(): Promise<void> {
    if (
      this.stopping ||
      this.captureRecoveryInFlight ||
      this.operatorAssistanceClaimed ||
      !this.cdp ||
      !this.browserCaptureExpected ||
      this.state !== "capturing"
    ) {
      return;
    }

    const captureState = await cdpEval(
      this.cdp,
      `(() => {
        const capture = window.__meterCapture;
        if (!capture) {
          return { present: false, phase: null, error: null };
        }
        return {
          present: true,
          phase: capture.state.phase || null,
          error: capture.state.error || null,
        };
      })()`,
    ).catch(() => null);

    if (captureState?.present && captureState.phase === "streaming") {
      if (
        this.launch.options.enable_transcription &&
        this.launch.app.transcription_provider === "mistral" &&
        this.lastCaptureStartedPayload &&
        !this.transcriptionSessionActive
      ) {
        const now = nowUnixMs();
        if (
          now - this.lastTranscriptionActivityAtUnixMs >= 10_000 &&
          now - this.lastTranscriptionReconnectAtUnixMs >= 10_000
        ) {
          this.captureRecoveryInFlight = true;
          try {
            this.lastTranscriptionReconnectAtUnixMs = now;
            await this.browserLog("capture health check detected inactive transcription session; reconnecting Mistral realtime");
            await this.getTranscriptionAdapter().start(this.lastCaptureStartedPayload);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.browserLog(`transcription health recovery failed: ${message}`);
          } finally {
            this.captureRecoveryInFlight = false;
          }
        }
      }
      return;
    }

    this.captureRecoveryInFlight = true;
    try {
      const description = captureState?.present ? `phase=${captureState.phase ?? "unknown"}` : "missing bootstrap";
      await this.browserLog(`capture health check detected ${description}; reinjecting browser capture bootstrap`);
      await this.injectCaptureBootstrap(this.cdp);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.browserLog(`capture health recovery failed: ${message}`);
    } finally {
      this.captureRecoveryInFlight = false;
    }
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
        emitEvent: (source, kind, payload, raw, tsUnixMs) => {
          this.noteTranscriptionEvent(kind, tsUnixMs);
          return this.emitEvent(source, kind, this.withCurrentSpeaker(kind, payload), raw, tsUnixMs);
        },
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
    const body = await response.json() as WorkerHeartbeatResponse;
    await this.syncOperatorAssistance(body.operator_assistance);
    if (body.stop_requested && !this.stopping) {
      await this.log("stop requested by coordinator");
      await this.complete("completed");
    }
  }

  private async syncOperatorAssistance(assistance: WorkerHeartbeatResponse["operator_assistance"]): Promise<void> {
    const claimed = assistance?.claimed ?? false;
    if (
      claimed === this.operatorAssistanceClaimed
      && (assistance?.operator ?? null) === this.operatorAssistanceOperator
      && (assistance?.reason ?? null) === this.operatorAssistanceReason
    ) {
      return;
    }
    this.operatorAssistanceClaimed = claimed;
    this.operatorAssistanceOperator = assistance?.operator ?? null;
    this.operatorAssistanceReason = assistance?.reason ?? null;
    if (claimed) {
      const summary = [this.operatorAssistanceOperator, this.operatorAssistanceReason].filter(Boolean).join(" :: ");
      await this.log(`operator assistance claimed${summary ? ` ${summary}` : ""}`);
      await this.browserLog(`operator assistance claimed${summary ? ` ${summary}` : ""}`);
      return;
    }
    await this.log("operator assistance released");
    await this.browserLog("operator assistance released");
  }

  private async waitForOperatorRelease(context: string): Promise<void> {
    if (!this.operatorAssistanceClaimed) {
      return;
    }
    await this.log(`automation paused for operator assistance at ${context}`);
    while (this.operatorAssistanceClaimed && !this.stopping && !this.completionSent) {
      await sleep(500);
    }
    if (!this.completionSent && !this.stopping) {
      await this.log(`automation resumed after operator assistance at ${context}`);
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
      const events = [...this.pendingEvents].sort((left, right) => left.seq - right.seq);
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
        const body = await response.text().catch(() => "");
        await this.log(`event flush failed with ${response.status}${body ? ` body=${body}` : ""}`);
        await sleep(1000);
        continue;
      }
      const highestSeq = events[events.length - 1].seq;
      this.pendingEvents = this.pendingEvents.filter((event) => event.seq > highestSeq);
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
    if (fatal && this.operatorAssistanceClaimed) {
      await this.log(`fatal error ${code} suppressed while operator assistance is active`);
      return;
    }
    if (fatal) {
      void this.complete("failed", errorPayload);
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
    this.browserCaptureExpected = true;
    const payload: AudioCaptureStartedPayload = {
      archive_stream_id: message.archive_stream_id,
      live_stream_id: message.live_stream_id,
      archive_content_type: message.archive_content_type,
      archive_codec: message.archive_codec,
      pcm_sample_rate_hz: message.pcm_sample_rate_hz,
      pcm_channels: message.pcm_channels,
    };
    this.lastCaptureStartedPayload = payload;
    this.lastTranscriptionActivityAtUnixMs = message.ts_unix_ms;
    await this.setState("capturing");
    await this.ensureArchiveEncoder(message);
    this.startPeriodicScreenshotCapture();
    await this.browserLog(`capture started archive=${message.archive_stream_id} live=${message.live_stream_id}`);
    await this.emitEvent("audio_capture", "audio.capture.started", payload, message, message.ts_unix_ms);
    await this.getTranscriptionAdapter().start(payload);
  }

  private isRecoverableCaptureStopReason(reason: BrowserCaptureStoppedMessage["reason"]): boolean {
    return reason === "audio-track-ended";
  }

  private async handleCaptureStopped(message: BrowserCaptureStoppedMessage): Promise<void> {
    const recoverable = this.isRecoverableCaptureStopReason(message.reason);
    this.browserCaptureExpected = recoverable;
    this.transcriptionSessionActive = false;
    await this.browserLog(`capture stopped reason=${message.reason}`);
    await this.emitEvent("audio_capture", "audio.capture.stopped", {
      reason: message.reason,
    }, message, message.ts_unix_ms);
    await this.getTranscriptionAdapter().stop(message.reason);
    if (recoverable) {
      await this.browserLog(`capture stop reason=${message.reason} is recoverable; restarting browser capture bootstrap`);
      if (this.cdp && !this.captureRecoveryInFlight && !this.stopping && !isTerminalState(this.state)) {
        this.captureRecoveryInFlight = true;
        try {
          await this.injectCaptureBootstrap(this.cdp);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          await this.browserLog(`recoverable capture restart failed: ${messageText}`);
        } finally {
          this.captureRecoveryInFlight = false;
        }
      }
      return;
    }
    if (this.launch.options.auto_stop_when_meeting_ends) {
      void this.complete("completed");
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
    if (event.kind === "zoom.meeting.left" && this.launch.options.auto_stop_when_meeting_ends && !this.stopping && !isTerminalState(this.state)) {
      void this.complete("completed");
    }
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

  private noteTranscriptionEvent(kind: EventKind, tsUnixMs?: number): void {
    const observedAt = tsUnixMs ?? nowUnixMs();
    if (kind === "transcription.session.started") {
      this.transcriptionSessionActive = true;
      this.lastTranscriptionActivityAtUnixMs = observedAt;
      return;
    }
    if (kind === "transcription.session.stopped") {
      this.transcriptionSessionActive = false;
      this.lastTranscriptionActivityAtUnixMs = observedAt;
      return;
    }
    if (kind === "transcription.segment.partial" || kind === "transcription.segment.final") {
      this.lastTranscriptionActivityAtUnixMs = observedAt;
    }
  }

  private ffmpegBinary(): string {
    return process.env.FFMPEG_BIN || "ffmpeg";
  }

  private async reportArchiveError(message: string, details?: Record<string, unknown>): Promise<void> {
    if (this.archiveErrorReported) {
      return;
    }
    this.archiveErrorReported = true;
    this.archiveEncoder.failed = true;
    await this.raiseError("archive_encoder_failed", message, false, {
      ffmpeg_bin: this.ffmpegBinary(),
      ...details,
    });
  }

  private async ensureArchiveEncoder(message: BrowserCaptureStartedMessage): Promise<void> {
    if (!this.launch.options.persist_archive_audio || this.archiveEncoder.process || this.archiveEncoder.failed) {
      return;
    }

    this.archiveEncoder.streamId = message.archive_stream_id;
    this.archiveEncoder.sampleRateHz = message.pcm_sample_rate_hz;
    this.archiveEncoder.channels = message.pcm_channels;

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "s16le",
      "-ar",
      String(message.pcm_sample_rate_hz),
      "-ac",
      String(message.pcm_channels),
      "-i",
      "pipe:0",
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "2",
      this.paths.archive_mp3_path,
    ];

    try {
      const child = spawn(this.ffmpegBinary(), args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
      this.archiveEncoder.process = child;
      this.archiveEncoder.closePromise = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.once("error", (error) => {
        void this.reportArchiveError("Failed to start ffmpeg archive encoder", {
          message: error.message,
        });
      });
      child.stderr.on("data", (chunk) => {
        const text = Buffer.from(chunk).toString("utf8").trim();
        if (!text) {
          return;
        }
        void this.log(`[ffmpeg] ${text}`);
      });
      await this.log(`archive encoder started path=${this.paths.archive_mp3_path}`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.reportArchiveError("Failed to start ffmpeg archive encoder", {
        message: messageText,
      });
    }
  }

  private async appendArchiveFrame(frame: ReturnType<typeof parsePcmFrame>): Promise<void> {
    if (!this.launch.options.persist_archive_audio || !this.archiveEncoder.process || this.archiveEncoder.failed) {
      return;
    }

    const sampleCount = frame.payload.byteLength / 2;
    const endedAt = frame.ts_unix_ms + Math.round((sampleCount / frame.sample_rate_hz) * 1000);
    if (this.archiveEncoder.startedAtUnixMs === null) {
      this.archiveEncoder.startedAtUnixMs = frame.ts_unix_ms;
    }
    this.archiveEncoder.endedAtUnixMs = endedAt;

    const chunk = Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    this.archiveEncoder.writeChain = this.archiveEncoder.writeChain
      .then(async () => {
        const child = this.archiveEncoder.process;
        if (!child || this.archiveEncoder.failed) {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(chunk, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      })
      .catch(async (error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        await this.reportArchiveError("Failed to write PCM frame into ffmpeg", {
          message: messageText,
        });
      });

    await this.archiveEncoder.writeChain;
  }

  private async finalizeArchive(): Promise<void> {
    if (!this.launch.options.persist_archive_audio || this.archiveEncoder.emitted || this.archiveEncoder.failed) {
      return;
    }

    const child = this.archiveEncoder.process;
    const closePromise = this.archiveEncoder.closePromise;
    if (!child || !closePromise) {
      return;
    }

    this.archiveEncoder.process = null;
    await this.archiveEncoder.writeChain;
    child.stdin.end();

    let exitCode: number | null;
    try {
      exitCode = await closePromise;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.reportArchiveError("ffmpeg archive encoder exited with an error", {
        message: messageText,
      });
      return;
    }

    if (exitCode !== 0) {
      await this.reportArchiveError(`ffmpeg archive encoder exited with code ${exitCode}`, {
        path: this.paths.archive_mp3_path,
      });
      return;
    }

    const file = Bun.file(this.paths.archive_mp3_path);
    if (!(await file.exists()) || file.size <= 0) {
      await this.reportArchiveError("ffmpeg did not produce an MP3 archive", {
        path: this.paths.archive_mp3_path,
      });
      return;
    }

    const startedAt = this.archiveEncoder.startedAtUnixMs;
    const endedAt = this.archiveEncoder.endedAtUnixMs ?? nowUnixMs();
    const audioObjectId = uuidv7(endedAt);
    await writeJsonFile(this.paths.archive_manifest_path, {
      chunks: [
        {
          audio_object_id: audioObjectId,
          archive_stream_id: this.archiveEncoder.streamId,
          chunk_seq: 1,
          path: this.paths.archive_mp3_path,
          byte_length: file.size,
          started_at_unix_ms: startedAt,
          ended_at_unix_ms: endedAt,
          sha256_hex: null,
        },
      ],
    });

    const payload: AudioChunkWrittenPayload = {
      audio_object_id: audioObjectId,
      stream_kind: "archive",
      stream_id: this.archiveEncoder.streamId ?? "archive",
      path: this.paths.archive_mp3_path,
      chunk_seq: 1,
      byte_length: file.size,
      content_type: "audio/mpeg",
      codec: "mp3",
      started_at_unix_ms: startedAt,
      ended_at_unix_ms: endedAt,
      sha256_hex: null,
    };
    this.archiveEncoder.emitted = true;
    await this.emitEvent("audio_capture", "audio.archive.chunk_written", payload, undefined, endedAt);
  }

  private async handlePcmFrame(bytes: Uint8Array): Promise<void> {
    const frame = parsePcmFrame(bytes);
    await this.appendArchiveFrame(frame);

    if (this.launch.options.persist_live_pcm && this.paths.live_pcm_dir) {
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
    }

    await this.getTranscriptionAdapter().pushFrame(frame);
  }

  async complete(finalState: "completed" | "failed" | "aborted", error?: ErrorRaisedPayload): Promise<void> {
    if (this.completionSent) {
      return;
    }
    this.completionSent = true;
    this.stopping = true;
    if (!isTerminalState(this.state)) {
      await this.setState(finalState === "completed" ? "stopping" : finalState, error);
    }
    await this.writeLifecycle(error ?? null);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.captureHealthTimer) {
      clearInterval(this.captureHealthTimer);
    }
    if (this.periodicScreenshotTimer) {
      clearInterval(this.periodicScreenshotTimer);
    }
    await this.attemptGracefulLeave();
    await this.stopChrome();
    await this.browserMessageQueue.catch(() => undefined);
    await this.getTranscriptionAdapter().stop(finalState);
    await this.finalizeArchive();
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
    this.server?.stop();
    await this.log(`completed with state=${finalState}`);
    await this.writeLifecycle(error ?? null);
    this.doneResolve?.();
  }
}
