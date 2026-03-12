#!/usr/bin/env bun
/**
 * CDP Spike: Automated Zoom meeting capture (single-tab)
 *
 * Self-contained script that:
 * 1. Starts a Bun server with WebSocket for audio
 * 2. Launches Chromium with CDP and auto-accept flags
 * 3. Opens Zoom web client, joins meeting
 * 4. Injects a hidden button, dispatches a trusted CDP click to trigger
 *    getDisplayMedia({ preferCurrentTab: true }) for self-capture
 * 5. Injects DOM observers for speaker/chat detection
 * 6. Proxies audio to Mistral for transcription
 */

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_WS_URL =
  "wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602";
const PORT = 3003;
const CDP_PORT = 9222;
const CHROME_BIN = process.env.CHROME_BIN || "/usr/bin/chromium";
const BOT_NAME = process.env.BOT_NAME || "Meeting Bot";
const RAW_URL = Bun.argv[2] || "";

if (!MISTRAL_API_KEY) {
  console.error("MISTRAL_API_KEY env var required");
  process.exit(1);
}
if (!RAW_URL) {
  console.error("Usage: bun run server.ts <zoom-url>");
  console.error('  e.g.: bun run server.ts "https://us05web.zoom.us/j/123456789?pwd=xxx"');
  process.exit(1);
}

// Convert any Zoom URL to web client format
function toWebClientUrl(raw: string): string {
  const url = new URL(raw);
  if (url.pathname.startsWith("/wc/")) return raw;
  const match = url.pathname.match(/\/j\/(\d+)/);
  if (!match) {
    console.error("Could not parse meeting ID from URL:", raw);
    process.exit(1);
  }
  const meetingId = match[1];
  const pwd = url.searchParams.get("pwd") || "";
  const wcUrl = new URL(`https://app.zoom.us/wc/join/${meetingId}`);
  if (pwd) wcUrl.searchParams.set("pwd", pwd);
  return wcUrl.toString();
}

const ZOOM_URL = toWebClientUrl(RAW_URL);
console.log(`[config] Web client URL: ${ZOOM_URL}`);

// ─── Bun Server ──────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/capture") {
      const upgraded = server.upgrade(req);
      if (!upgraded) return new Response("WS upgrade failed", { status: 400 });
      return undefined as any;
    }

    // Serve capture.html
    if (url.pathname === "/capture.html") {
      return new Response(Bun.file(new URL("./capture.html", import.meta.url).pathname));
    }

    return new Response("cdp-spike server");
  },

  websocket: {
    open(ws) {
      console.log("[server] Capture client connected");
      (ws as any).mistral = null;
      (ws as any).mistralReady = false;
      (ws as any).audioBuffer = [] as string[];
    },

    message(ws, message) {
      if (typeof message === "string") {
        let msg: any;
        try { msg = JSON.parse(message); } catch { return; }

        switch (msg.type) {
          case "audio-config":
            console.log("[server] Audio config received, connecting to Mistral...");
            connectMistral(ws as any, msg);
            break;
          case "speaker":
            console.log(`[server] Speaker: ${msg.name}`);
            break;
          case "chat":
            console.log(`[server] Chat: ${msg.sender} -> ${msg.receiver || "everyone"}: ${msg.text}`);
            break;
          default:
            console.log("[server] Event:", msg.type);
        }
      } else {
        // Binary PCM audio
        const b64 = Buffer.from(message).toString("base64");
        forwardAudio(ws as any, b64);
      }
    },

    close(ws) {
      console.log("[server] Capture client disconnected");
      const m = (ws as any).mistral;
      if (m && m.readyState <= WebSocket.OPEN) m.close();
    },
  },
});

function connectMistral(ws: any, config: any) {
  const upstream = new WebSocket(MISTRAL_WS_URL, {
    headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` },
  } as any);

  ws.mistral = upstream;

  upstream.addEventListener("open", () => {
    console.log("[server] Mistral connected");
    upstream.send(JSON.stringify({
      type: "session.update",
      session: { audio_format: { encoding: "pcm_s16le", sample_rate: config.sampleRate || 16000 } },
    }));
    ws.mistralReady = true;
    for (const b64 of ws.audioBuffer) {
      upstream.send(JSON.stringify({ type: "input_audio.append", audio: b64 }));
    }
    ws.audioBuffer = [];
  });

  upstream.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : event.data.toString();
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "transcription.text.delta") {
        process.stdout.write(parsed.text);
      } else {
        console.log("[server] Mistral:", parsed.type);
      }
    } catch {}
    try { ws.send(data); } catch {}
  });

  upstream.addEventListener("close", () => { console.log("[server] Mistral closed"); ws.mistralReady = false; });
  upstream.addEventListener("error", () => { console.error("[server] Mistral error"); });
}

function forwardAudio(ws: any, b64: string) {
  if (ws.mistralReady && ws.mistral) {
    ws.mistral.send(JSON.stringify({ type: "input_audio.append", audio: b64 }));
  } else if (ws.audioBuffer) {
    ws.audioBuffer.push(b64);
  }
}

console.log(`[server] Listening on http://localhost:${PORT}`);

// ─── Launch Chromium ─────────────────────────────────────────

const userDataDir = `/tmp/cdp-spike-${Date.now()}`;

const chromeArgs = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  // Auto-accept getDisplayMedia picker / preferCurrentTab confirmation
  "--auto-select-desktop-capture-source=Zoom",
  "--auto-accept-this-tab-capture",
  "--autoplay-policy=no-user-gesture-required",
  // Automation
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
];

console.log(`[chrome] Launching Chromium...`);
const chrome = Bun.spawn([CHROME_BIN, ...chromeArgs, "about:blank"], {
  stdout: "ignore",
  stderr: "ignore",
});

// ─── CDP Helpers ─────────────────────────────────────────────

async function waitForCDP(maxWait = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (resp.ok) return;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error("CDP did not start in time");
}

class CDPSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private listeners = new Map<string, Function[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      if (msg.method) {
        for (const h of this.listeners.get(msg.method) || []) h(msg.params);
      }
    });
  }

  async send(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: Function) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method)!.push(handler);
  }
}

async function connectCDP(targetId: string): Promise<CDPSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${CDP_PORT}/devtools/page/${targetId}`);
    ws.addEventListener("open", () => resolve(new CDPSession(ws)));
    ws.addEventListener("error", (e) => reject(e));
  });
}

async function cdpEval(cdp: CDPSession, expression: string, opts: { contextId?: number; awaitPromise?: boolean } = {}): Promise<any> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, ...opts });
  if (result.exceptionDetails) {
    throw new Error(`JS error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

async function cdpWaitFor(cdp: CDPSession, expression: string, opts: { timeout?: number; interval?: number } = {}): Promise<any> {
  const timeout = opts.timeout || 30000;
  const interval = opts.interval || 500;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = await cdpEval(cdp, expression);
    if (val) return val;
    await Bun.sleep(interval);
  }
  throw new Error(`Timed out waiting for: ${expression.substring(0, 80)}`);
}

// Dismiss any visible popup dialogs (OK, Got it, etc.)
async function dismissDialogs(cdp: CDPSession) {
  await cdpEval(cdp, `
    (() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = btn.textContent.trim();
        if (['OK','Got it','Got It','Close','Dismiss','Not Now','Maybe Later','Skip'].includes(t) && btn.offsetParent !== null)
          btn.click();
      }
    })()
  `);
}

// ─── Main Flow ───────────────────────────────────────────────

await waitForCDP();
console.log("[chrome] CDP ready");

async function run() {
  // Get the blank tab
  const tabs = await fetch(`http://localhost:${CDP_PORT}/json/list`).then(r => r.json());
  const tab = tabs.find((t: any) => t.type === "page");
  if (!tab) throw new Error("No page target found");

  const cdp = await connectCDP(tab.id);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Forward browser console to our terminal
  cdp.on("Runtime.consoleAPICalled", (params: any) => {
    const text = params.args?.map((a: any) => a.value ?? a.description ?? "").join(" ");
    if (text) console.log(`[browser] ${text}`);
  });

  // Grant camera/mic permissions
  await cdp.send("Browser.grantPermissions", {
    origin: "https://app.zoom.us",
    permissions: ["audioCapture", "videoCapture", "displayCapture", "notifications"],
  });
  console.log("[cdp] Granted permissions");

  // ─── Step 1: Navigate to Zoom and join ───
  console.log(`[cdp] Navigating to Zoom...`);
  const loadPromise = new Promise<void>(r => { cdp.on("Page.loadEventFired", () => r()); });
  await cdp.send("Page.navigate", { url: ZOOM_URL });
  await loadPromise;
  console.log("[cdp] Page loaded");
  await Bun.sleep(2000);

  // Wait for join form
  console.log("[cdp] Looking for join form...");
  await cdpWaitFor(cdp, `!!document.getElementById('input-for-name')`);

  // Mute mic
  await cdpEval(cdp, `
    (() => {
      const btn = document.getElementById('preview-audio-control-button');
      if (btn && btn.textContent.trim() !== 'Unmute') btn.click();
    })()
  `);
  console.log("[cdp] Muted mic");

  // Fill name
  await cdpEval(cdp, `
    (() => {
      const input = document.getElementById('input-for-name');
      if (!input) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(BOT_NAME)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  console.log(`[cdp] Filled name: "${BOT_NAME}"`);
  await Bun.sleep(500);

  // Click Join
  await cdpWaitFor(cdp, `!document.querySelector('.preview-join-button')?.classList.contains('zm-btn--disabled')`);
  await cdpEval(cdp, `document.querySelector('.preview-join-button')?.click()`);
  console.log("[cdp] Clicked Join");

  // ─── Step 2: Wait for meeting to load ───
  console.log("[cdp] Waiting for meeting...");
  await Bun.sleep(3000);

  for (let i = 0; i < 20; i++) {
    await dismissDialogs(cdp);
    const hasMeeting = await cdpEval(cdp, `!!document.getElementById('meeting-app')`);
    if (hasMeeting) {
      console.log("[cdp] Meeting loaded");
      break;
    }
    console.log(`[cdp] Waiting... (attempt ${i + 1})`);
    await Bun.sleep(3000);
  }

  await Bun.sleep(2000);
  await dismissDialogs(cdp);

  // ─── Step 3: Inject audio capture + DOM observers (single tab) ───
  // Strategy: inject a hidden button, add click handler that calls getDisplayMedia,
  // then use CDP Input.dispatchMouseEvent to trigger a trusted click.
  // The --auto-select-desktop-capture-source=Zoom flag auto-accepts the picker.

  console.log("[cdp] Injecting capture + observer code into Zoom tab...");

  // First, inject the capture setup code (adds button + handler)
  await cdpEval(cdp, `
    (() => {
      const btn = document.createElement('button');
      btn.id = '__cdp_capture_btn';
      btn.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:999999;';
      document.body.appendChild(btn);

      btn.addEventListener('click', async (event) => {
        if (window.__captureStarted) return;
        window.__captureStarted = true;
        btn.remove();
        console.log('[capture] Button clicked (trusted=' + event.isTrusted + '), calling getDisplayMedia...');
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,  // required by spec, we stop it immediately
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });
          const audioTracks = stream.getAudioTracks();
          stream.getVideoTracks().forEach(t => t.stop());
          console.log('[capture] Got stream: audio=' + audioTracks.length);
          console.log('[capture] Audio track settings:', JSON.stringify(audioTracks[0]?.getSettings()));

          if (audioTracks.length === 0) {
            console.error('[capture] No audio tracks!');
            return;
          }

          // Connect WebSocket
          const ws = new WebSocket("ws://localhost:${PORT}/ws/capture");
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
          console.log('[capture] WebSocket connected');

          // Audio processing
          const TARGET_RATE = 16000;
          const CHUNK_MS = 480;
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));

          const workletCode = \`
            class PCMExtractor extends AudioWorkletProcessor {
              process(inputs) {
                const ch = inputs[0]?.[0];
                if (ch?.length > 0) this.port.postMessage(ch);
                return true;
              }
            }
            registerProcessor('pcm-extractor', PCMExtractor);
          \`;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          await audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));

          const pcmNode = new AudioWorkletNode(audioCtx, 'pcm-extractor');
          source.connect(pcmNode);
          // Connect to destination so audio graph stays active (required for process() to fire)
          pcmNode.connect(audioCtx.destination);

          // Expose for debugging
          window.__audioCtx = audioCtx;
          window.__stream = stream;
          window.__sampleCount = 0;

          ws.send(JSON.stringify({ type: 'audio-config', sampleRate: TARGET_RATE }));

          const sourceRate = audioCtx.sampleRate;
          const samplesPerChunk = Math.floor(TARGET_RATE * CHUNK_MS / 1000);
          let buf = [];

          pcmNode.port.onmessage = (e) => {
            window.__sampleCount = (window.__sampleCount || 0) + e.data.length;
            if (ws.readyState !== WebSocket.OPEN) return;
            const samples = e.data;
            const ratio = TARGET_RATE / sourceRate;
            const outLen = Math.floor(samples.length * ratio);
            for (let i = 0; i < outLen; i++) {
              const s = i / ratio;
              const lo = Math.floor(s);
              const hi = Math.min(lo + 1, samples.length - 1);
              const f = s - lo;
              buf.push(samples[lo] * (1 - f) + samples[hi] * f);
            }
            while (buf.length >= samplesPerChunk) {
              const chunk = buf.splice(0, samplesPerChunk);
              const pcm = new Int16Array(chunk.length);
              for (let i = 0; i < chunk.length; i++) {
                const v = Math.max(-1, Math.min(1, chunk[i]));
                pcm[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
              }
              ws.send(pcm.buffer);
            }
          };

          audioTracks[0].addEventListener('ended', () => {
            console.log('[capture] Audio track ended');
            ws.close();
          });

          console.log('[capture] Streaming audio at ' + TARGET_RATE + 'Hz');
          window.__captureWs = ws;
        } catch (e) {
          console.error('[capture] getDisplayMedia failed:', e.message || e);
        }
      });

      console.log('[capture] Button injected, ready for CDP click');
    })()
  `);

  // Now dispatch a trusted click via CDP Input domain
  console.log("[cdp] Dispatching trusted click to trigger getDisplayMedia...");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: 0, y: 0, button: "left", clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1,
  });

  // Wait for getDisplayMedia to resolve (auto-accepted by Chrome flag)
  console.log("[cdp] Waiting for capture to start...");
  await cdpWaitFor(cdp, `!!window.__captureWs`, { timeout: 15000 });
  console.log("[cdp] Audio capture active!");

  // ─── Step 4: Inject DOM observers ───
  console.log("[cdp] Injecting DOM observers...");

  const observerResult = await cdpEval(cdp, `
    (async () => {
      const ws = window.__captureWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const fallbackWs = new WebSocket("ws://localhost:${PORT}/ws/capture");
        await new Promise((res, rej) => { fallbackWs.onopen = res; fallbackWs.onerror = rej; });
        window.__observerWs = fallbackWs;
      }
      const sendWs = window.__observerWs || ws;

      // ── Speaker detection ──
      // Works with both gallery view and speaker-bar view layouts
      let currentSpeaker = null;

      function checkSpeaker() {
        // Match any video frame with --active suffix in its class
        const active = document.querySelector("[class*='video-frame--active']");
        if (!active) return;
        const nameEl = active.querySelector(".video-avatar__avatar-name");
        const name = nameEl?.textContent?.trim();
        if (name && name !== currentSpeaker) {
          currentSpeaker = name;
          console.log("[observer] Speaker:", name);
          sendWs.send(JSON.stringify({ type: "speaker", name, time: Date.now() }));
        }
      }

      // Observe from #meeting-app to catch both view layouts and layout switches
      const meetingApp = document.getElementById("meeting-app");
      if (meetingApp) {
        new MutationObserver(() => checkSpeaker()).observe(meetingApp, {
          attributes: true, attributeFilter: ["class"], subtree: true, childList: true,
        });
      }
      // Also poll as backup in case MutationObserver misses changes
      setInterval(checkSpeaker, 1000);
      checkSpeaker();

      // ── Chat detection ──
      const seenChat = new Set();
      function scanChat() {
        const cl = document.querySelector("[class*='chat-container'] [class*='chat-list']")
          || document.querySelector(".chat-container__chat-list");
        if (!cl) return false;
        new MutationObserver((muts) => {
          for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const items = n.classList?.contains("chat-item-container")
              ? [n]
              : [...(n.querySelectorAll?.("[class*='chat-item']") || [])];
            for (const el of items) {
              const id = el.textContent?.trim().substring(0, 100);
              if (seenChat.has(id)) continue;
              seenChat.add(id);
              const sender = el.querySelector("[class*='chat-item__sender']")?.textContent?.trim();
              const receiver = el.querySelector("[class*='chat-item__receiver']")?.textContent?.trim();
              const text = el.querySelector("[class*='message__text']")?.textContent?.trim();
              if (text) {
                console.log("[observer] Chat:", sender, "->", receiver || "everyone", ":", text);
                sendWs.send(JSON.stringify({ type: "chat", sender, receiver, text, ts: Date.now() }));
              }
            }
          }
        }).observe(cl, { childList: true, subtree: true });
        return true;
      }

      // Poll for chat container (may not exist until chat panel is opened)
      let chatOk = false;
      const chatPoll = setInterval(() => {
        if (!chatOk) chatOk = scanChat();
        if (chatOk) clearInterval(chatPoll);
      }, 2000);

      return "observers-started";
    })()
  `, { awaitPromise: true });
  console.log("[cdp] Observers:", observerResult);

  console.log("\n[ready] Monitoring meeting. Press Ctrl+C to stop.\n");
}

await Bun.sleep(500);
run().catch((err) => {
  console.error("[fatal]", err);
});

process.on("SIGINT", () => {
  console.log("\n[cleanup] Shutting down...");
  chrome.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  chrome.kill();
  process.exit(0);
});
