export interface BootstrapScriptOptions {
  browser_token: string;
  meeting_run_id: string;
  room_id: string;
  worker_base_url: string;
  open_chat_panel: boolean;
}

export function renderBootstrapScript(options: BootstrapScriptOptions): string {
  const wsUrl = `${options.worker_base_url.replace(/^http/, "ws")}/internal/browser/session?token=${options.browser_token}`;

  return `
(function bootstrapZoomerCapture() {
  if (window.__zoomerCapture) {
    return;
  }

  const config = ${JSON.stringify({
    wsUrl,
    meetingRunId: options.meeting_run_id,
    roomId: options.room_id,
    openChatPanel: options.open_chat_panel,
  })};

  const state = {
    phase: "idle",
    error: null,
    archiveStreamId: null,
    liveStreamId: null,
    runPromise: null,
  };
  const captureButtonId = "__zoomer_capture_btn";

  function setPhase(phase, error) {
    state.phase = phase;
    state.error = error || null;
  }

  function encodePcmFrame(streamSeq, tsUnixMs, sampleRateHz, payload) {
    const header = new ArrayBuffer(28);
    const view = new DataView(header);
    const magic = new Uint8Array(header, 0, 4);
    magic.set([90, 80, 67, 77]);
    view.setUint16(4, 1, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, streamSeq, true);
    view.setBigUint64(12, BigInt(tsUnixMs), true);
    view.setUint32(20, sampleRateHz, true);
    view.setUint32(24, payload.byteLength, true);
    const joined = new Uint8Array(28 + payload.byteLength);
    joined.set(new Uint8Array(header), 0);
    joined.set(new Uint8Array(payload), 28);
    return joined.buffer;
  }

  async function openChatPanel() {
    if (!config.openChatPanel) {
      return;
    }
    for (const button of document.querySelectorAll("button")) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
      if (label === "chat" || label.includes("open chat")) {
        button.click();
        return;
      }
    }
  }

  function emitLifecycleStop(session, reason) {
    if (!session || session.readyState !== WebSocket.OPEN) {
      return;
    }
    session.send(JSON.stringify({
      type: "capture.stopped",
      reason,
      ts_unix_ms: Date.now(),
    }));
  }

  function installCaptureButton() {
    const existing = document.getElementById(captureButtonId);
    if (existing) {
      return captureButtonId;
    }
    const button = document.createElement("button");
    button.id = captureButtonId;
    button.type = "button";
    button.ariaLabel = "Start Zoomer capture";
    button.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:12px",
      "width:44px",
      "height:44px",
      "opacity:0.01",
      "z-index:2147483647",
      "border:0",
      "padding:0",
      "background:#000",
      "pointer-events:auto",
    ].join(";");
    button.addEventListener("click", () => {
      void start();
    });
    document.body.appendChild(button);
    return captureButtonId;
  }

  async function start() {
    if (state.runPromise) {
      return state.runPromise;
    }

    setPhase("starting");
    state.runPromise = (async () => {
      let session = null;
      let stream = null;
      let audioContext = null;

      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
          },
          preferCurrentTab: true,
        });

        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        videoTracks.forEach((track) => track.stop());
        console.log("[capture] audio track settings", JSON.stringify(audioTracks[0]?.getSettings() || null));
        if (audioTracks.length === 0) {
          throw new Error("Display capture did not include audio");
        }

        session = new WebSocket(config.wsUrl);
        await new Promise((resolve, reject) => {
          session.addEventListener("open", resolve, { once: true });
          session.addEventListener("error", reject, { once: true });
        });

        session.send(JSON.stringify({
          type: "hello",
          page_url: location.href,
          user_agent: navigator.userAgent,
          ts_unix_ms: Date.now(),
        }));

        await openChatPanel();

        const archiveStreamId = crypto.randomUUID();
        const liveStreamId = crypto.randomUUID();
        state.archiveStreamId = archiveStreamId;
        state.liveStreamId = liveStreamId;

        audioContext = new AudioContext();
        await audioContext.resume();
        const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
        const workletUrl = URL.createObjectURL(new Blob([\`
          class PcmExtractor extends AudioWorkletProcessor {
            process(inputs) {
              const channel = inputs[0] && inputs[0][0];
              if (channel && channel.length) {
                this.port.postMessage(channel);
              }
              return true;
            }
          }
          registerProcessor("pcm-extractor", PcmExtractor);
        \`], { type: "application/javascript" }));
        await audioContext.audioWorklet.addModule(workletUrl);
        const extractor = new AudioWorkletNode(audioContext, "pcm-extractor");
        source.connect(extractor);
        extractor.connect(audioContext.destination);

        const targetRate = 16000;
        let pcmSeq = 1;
        let sampleBuffer = [];
        const samplesPerChunk = Math.floor(targetRate * 0.48);
        const sourceRate = audioContext.sampleRate;

        extractor.port.onmessage = (event) => {
          if (session.readyState !== WebSocket.OPEN) {
            return;
          }
          const samples = event.data;
          const ratio = targetRate / sourceRate;
          const outputLength = Math.floor(samples.length * ratio);
          for (let index = 0; index < outputLength; index += 1) {
            const sourceIndex = index / ratio;
            const lower = Math.floor(sourceIndex);
            const upper = Math.min(lower + 1, samples.length - 1);
            const fraction = sourceIndex - lower;
            sampleBuffer.push(samples[lower] * (1 - fraction) + samples[upper] * fraction);
          }
          while (sampleBuffer.length >= samplesPerChunk) {
            const chunk = sampleBuffer.splice(0, samplesPerChunk);
            const pcm = new Int16Array(chunk.length);
            for (let index = 0; index < chunk.length; index += 1) {
              const value = Math.max(-1, Math.min(1, chunk[index]));
              pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
            }
            session.send(encodePcmFrame(pcmSeq++, Date.now(), targetRate, pcm.buffer));
          }
        };

        session.send(JSON.stringify({
          type: "capture.started",
          archive_stream_id: archiveStreamId,
          live_stream_id: liveStreamId,
          archive_content_type: "audio/mpeg",
          archive_codec: "mp3",
          pcm_sample_rate_hz: targetRate,
          pcm_channels: 1,
          ts_unix_ms: Date.now(),
        }));

        let currentSpeaker = null;
        function emitDomEvent(kind, payload) {
          if (session.readyState !== WebSocket.OPEN) {
            return;
          }
          session.send(JSON.stringify({
            type: "dom.event",
            event: {
              meeting_run_id: config.meetingRunId,
              room_id: config.roomId,
              seq: 0,
              source: "zoom_dom",
              kind,
              ts_unix_ms: Date.now(),
              payload,
            },
          }));
        }

        function scanSpeaker() {
          const active = document.querySelector(
            [
              ".speaker-active-container__wrap",
              ".speaker-active-container__video-frame",
              "[class*='video-frame--active']",
              "[class*='active-speaker']",
            ].join(", "),
          );
          if (!active) {
            return;
          }
          const name = (
            active.querySelector(".video-avatar__avatar-name")?.textContent ||
            active.querySelector(".video-avatar__avatar-footer span")?.textContent ||
            active.querySelector("span[role='none']")?.textContent ||
            active.textContent ||
            ""
          ).trim() || null;
          if (name && name !== currentSpeaker) {
            currentSpeaker = name;
            emitDomEvent("zoom.speaker.active", {
              speaker_display_name: name,
            });
          }
        }

        const seenChat = new Set();
        function observeChatList(chatList) {
          new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) {
                  continue;
                }
                const candidates = node.matches("[class*='chat-item']")
                  ? [node]
                  : Array.from(node.querySelectorAll("[class*='chat-item']"));
                for (const element of candidates) {
                  const id = (element.textContent || "").trim().slice(0, 120);
                  if (!id || seenChat.has(id)) {
                    continue;
                  }
                  seenChat.add(id);
                  const sender = element.querySelector("[class*='chat-item__sender']")?.textContent?.trim() || null;
                  const receiver = element.querySelector("[class*='chat-item__receiver']")?.textContent?.trim() || null;
                  const text = element.querySelector("[class*='message__text']")?.textContent?.trim() || "";
                  if (text) {
                    emitDomEvent("zoom.chat.message", {
                      chat_message_id: crypto.randomUUID(),
                      sender_display_name: sender,
                      receiver_display_name: receiver,
                      visibility: receiver ? "direct" : "everyone",
                      text,
                      sent_at_unix_ms: Date.now(),
                    });
                  }
                }
              }
            }
          }).observe(chatList, { childList: true, subtree: true });
        }

        const meetingApp = document.getElementById("meeting-app");
        if (meetingApp) {
          new MutationObserver(scanSpeaker).observe(meetingApp, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
          });
          scanSpeaker();
        }
        setInterval(scanSpeaker, 1000);

        const chatPoll = setInterval(() => {
          const chatList = document.querySelector("[class*='chat-container'] [class*='chat-list']")
            || document.querySelector(".chat-container__chat-list");
          if (chatList) {
            observeChatList(chatList);
            clearInterval(chatPoll);
          }
        }, 1500);

        audioTracks[0].addEventListener("ended", () => {
          setPhase("stopped");
          emitLifecycleStop(session, "ended");
          session.close();
          if (audioContext) {
            void audioContext.close();
          }
        });

        session.addEventListener("close", () => {
          if (state.phase !== "error" && state.phase !== "stopped") {
            setPhase("stopped");
          }
        });

        setPhase("streaming");
        return {
          archiveStreamId,
          liveStreamId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPhase("error", message);
        try {
          if (stream) {
            stream.getTracks().forEach((track) => track.stop());
          }
        } catch {}
        try {
          if (audioContext) {
            await audioContext.close();
          }
        } catch {}
        try {
          emitLifecycleStop(session, "error");
          if (session) {
            session.close();
          }
        } catch {}
        state.runPromise = null;
        throw error;
      }
    })();

    return state.runPromise;
  }

  window.__zoomerCapture = {
    start,
    state,
    installCaptureButton,
    buttonId: captureButtonId,
  };
})();
`;
}
