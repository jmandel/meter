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
(function bootstrapMeterCapture() {
  if (window.__meterCapture) {
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
  const captureButtonId = "__meter_capture_btn";

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
      if (
        label === "chat"
        || label.includes("open chat")
        || label.includes("open the chat panel")
        || label.includes("close the chat panel")
      ) {
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
    button.ariaLabel = "Start Meter capture";
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

  function toJsonSafe(value, depth = 0) {
    if (depth > 8) {
      return null;
    }
    if (
      value === null
      || value === undefined
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafe(entry, depth + 1));
    }
    if (value instanceof Map) {
      return Array.from(value.entries()).map(([key, entry]) => [
        typeof key === "string" ? key : String(key),
        toJsonSafe(entry, depth + 1),
      ]);
    }
    if (value instanceof Set) {
      return Array.from(value.values()).map((entry) => toJsonSafe(entry, depth + 1));
    }
    if (typeof value === "object") {
      const json = {};
      for (const [key, entry] of Object.entries(value)) {
        json[key] = toJsonSafe(entry, depth + 1);
      }
      return json;
    }
    return String(value);
  }

  function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function resolveReduxStore() {
    const roots = [document.getElementById("root"), document.getElementById("meeting-app")].filter(Boolean);
    for (const rootNode of roots) {
      const reactKeys = Object.getOwnPropertyNames(rootNode).filter((key) => key.startsWith("__reactContainer") || key.startsWith("__reactFiber"));
      for (const reactKey of reactKeys) {
        const initialFiber = rootNode[reactKey];
        const queue = [initialFiber];
        const seen = new Set();
        while (queue.length) {
          const fiber = queue.shift();
          if (!fiber || seen.has(fiber)) {
            continue;
          }
          seen.add(fiber);
          const directStore = fiber.memoizedProps?.store;
          if (directStore && typeof directStore.getState === "function" && typeof directStore.subscribe === "function") {
            return directStore;
          }
          const contextStore = fiber.memoizedProps?.value?.store;
          if (contextStore && typeof contextStore.getState === "function" && typeof contextStore.subscribe === "function") {
            return contextStore;
          }
          if (fiber.child) {
            queue.push(fiber.child);
          }
          if (fiber.sibling) {
            queue.push(fiber.sibling);
          }
        }
      }
    }
    return null;
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
        function emitDomEvent(kind, payload, raw) {
          if (session.readyState !== WebSocket.OPEN) {
            return;
          }
          session.send(JSON.stringify({
            type: "dom.event",
            raw: raw === undefined ? undefined : toJsonSafe(raw),
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

        const seenChatState = new Map();
        function parseChatRowLabel(rowLabel) {
          if (!rowLabel) {
            return null;
          }
          const match = rowLabel.match(/^(.*?) to (.*?), (\d{1,2}:\d{2} [AP]M), (.*)$/);
          if (!match) {
            return null;
          }
          return {
            sender: match[1]?.trim() || null,
            receiver: match[2]?.trim() || null,
            timeLabel: match[3]?.trim() || null,
            text: match[4]?.trim() || "",
          };
        }

        function extractChatRecord(element) {
          const container = element.matches("[class*='chat-item-container']")
            ? element
            : element.closest("[class*='chat-item-container']");
          if (!(container instanceof HTMLElement)) {
            return null;
          }
          const rowLabel = container.querySelector("[class*='new-chat-message__container'][role='row']")?.getAttribute("aria-label") || null;
          const parsedRow = parseChatRowLabel(rowLabel);
          const sender = container.querySelector("[class*='chat-item__sender']")?.textContent?.trim() || parsedRow?.sender || null;
          const receiver = container.querySelector("[class*='chat-item__receiver']")?.textContent?.trim() || parsedRow?.receiver || null;
          const text = (
            container.querySelector("[class*='new-chat-message__text-box']")?.textContent
            || container.querySelector("[class*='chat-rtf-box__display']")?.textContent
            || container.querySelector("[class*='message__text']")?.textContent
            || parsedRow?.text
            || ""
          ).trim();
          const timeLabel = container.querySelector("[class*='time-stamp']")?.textContent?.trim() || parsedRow?.timeLabel || null;
          if (!text) {
            return null;
          }
          const dedupeKey = rowLabel || [sender || "", receiver || "", timeLabel || "", text].join("|");
          return {
            chatMessageId: dedupeKey,
            signature: JSON.stringify({
              sender,
              receiver,
              timeLabel,
              text,
            }),
            payload: {
              chat_message_id: dedupeKey,
              sender_display_name: sender,
              receiver_display_name: receiver,
              visibility: receiver && receiver.toLowerCase() !== "everyone" ? "direct" : "everyone",
              text,
              sent_at_unix_ms: Date.now(),
            },
            raw: {
              row_label: rowLabel,
              sender,
              receiver,
              time_label: timeLabel,
              text,
              capture_strategy: "dom_fallback",
            },
          };
        }

        function extractStoreChatRecord(message) {
          if (!message || typeof message !== "object") {
            return null;
          }
          const content = message.content && typeof message.content === "object" ? message.content : {};
          const chatMessageId = (
            message.msgId
            || message.xmppMsgId
            || content.msgId
            || content.xmppMsgId
            || null
          );
          const text = (
            content.text
            || content.snsBody
            || message.text
            || ""
          ).trim();
          if (!chatMessageId || !text) {
            return null;
          }
          const senderDisplayName = (
            message.sender
            || content.senderName
            || message.chatSender?.displayName
            || null
          );
          const receiverDisplayName = (
            message.receiver
            || message.chatReceiver?.displayName
            || null
          );
          const senderUserId = toFiniteNumber(message.senderId ?? message.chatSender?.userId);
          const receiverUserId = toFiniteNumber(message.receiverId ?? message.chatReceiver?.userId);
          const mainChatMessageId = typeof message.mainMsgId === "string" && message.mainMsgId.trim() ? message.mainMsgId.trim() : null;
          const threadReplyCount = toFiniteNumber(message.threadCount) ?? 0;
          const sentAtUnixMs = toFiniteNumber(message.t ?? content.t) ?? Date.now();
          const isThreadReply = Boolean(message.isThread || mainChatMessageId);
          const isEdited = Boolean(message.isEdited || content.isEdited);
          const chatType = typeof content.chatType === "string" ? content.chatType : null;
          const details = {
            capture_strategy: "redux_store",
            sender_user_id: senderUserId,
            receiver_user_id: receiverUserId,
            sender_screen_name: typeof message.senderSN === "string" ? message.senderSN : null,
            receiver_jid: typeof message.receiverJid === "string" ? message.receiverJid : null,
            channel_id: typeof content.toChannel === "string" ? content.toChannel : null,
            chat_type: chatType,
            msg_type: typeof content.msgType === "string" ? content.msgType : null,
            msg_feature: typeof content.msgFeature === "string" ? content.msgFeature : null,
            main_chat_message_id: mainChatMessageId,
            thread_reply_count: threadReplyCount,
            truncate_count: toFiniteNumber(message.truncateCount),
            fold: toFiniteNumber(message.fold),
            is_thread_reply: isThreadReply,
            is_thread_root: !mainChatMessageId && threadReplyCount > 0,
            is_edited: isEdited,
            is_my_message: Boolean(message.isMyMessage || message.isSenderMe),
            is_to_my_message: Boolean(message.isToMyMessage),
            is_at_me: Boolean(message.isAtMe),
            is_at_all: Boolean(message.isAtAll),
            reaction_count: toFiniteNumber(message.voteCount),
          };
          return {
            chatMessageId,
            signature: JSON.stringify({
              text,
              senderDisplayName,
              receiverDisplayName,
              senderUserId,
              receiverUserId,
              mainChatMessageId,
              threadReplyCount,
              isThreadReply,
              isEdited,
              chatType,
              reactionCount: details.reaction_count,
            }),
            payload: {
              chat_message_id: chatMessageId,
              sender_display_name: senderDisplayName,
              sender_user_id: senderUserId,
              receiver_display_name: receiverDisplayName,
              receiver_user_id: receiverUserId,
              visibility: receiverDisplayName && receiverDisplayName.toLowerCase() !== "everyone" ? "direct" : "everyone",
              text,
              sent_at_unix_ms: sentAtUnixMs,
              main_chat_message_id: mainChatMessageId,
              thread_reply_count: threadReplyCount,
              is_thread_reply: isThreadReply,
              is_edited: isEdited,
              chat_type: chatType,
              details,
            },
            raw: message,
          };
        }

        function emitChatRecord(record) {
          if (!record) {
            return;
          }
          const previousSignature = seenChatState.get(record.chatMessageId);
          if (previousSignature === record.signature) {
            return;
          }
          seenChatState.set(record.chatMessageId, record.signature);
          emitDomEvent("zoom.chat.message", record.payload, record.raw);
        }

        function emitChatFromNode(node) {
          if (!(node instanceof HTMLElement)) {
            return;
          }
          const candidates = node.matches("[class*='chat-item-container']")
            ? [node]
            : Array.from(node.querySelectorAll("[class*='chat-item-container']"));
          for (const candidate of candidates) {
            const record = extractChatRecord(candidate);
            emitChatRecord(record);
          }
        }

        function observeChatList(chatList) {
          for (const existing of chatList.querySelectorAll("[class*='chat-item-container']")) {
            emitChatFromNode(existing);
          }
          new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                emitChatFromNode(node);
              }
            }
          }).observe(chatList, { childList: true, subtree: true });
        }

        function observeChatStore() {
          const store = resolveReduxStore();
          if (!store) {
            return false;
          }
          const processState = () => {
            const stateSnapshot = store.getState();
            const messages = stateSnapshot?.newChat?.meetingChat
              || stateSnapshot?.chat?.meetingChat
              || [];
            if (!Array.isArray(messages)) {
              return;
            }
            for (const message of messages) {
              emitChatRecord(extractStoreChatRecord(message));
            }
          };
          processState();
          store.subscribe(processState);
          return true;
        }

        const seenAttendees = new Map();
        function buildAttendeeId(attendee) {
          const userId = toFiniteNumber(attendee?.userId);
          if (userId !== null) {
            return "zoom_user:" + userId;
          }
          if (typeof attendee?.strConfUserID === "string" && attendee.strConfUserID.trim()) {
            return "conf_user:" + attendee.strConfUserID.trim();
          }
          if (typeof attendee?.zoomID === "string" && attendee.zoomID.trim()) {
            return "zoom_id:" + attendee.zoomID.trim();
          }
          if (typeof attendee?.displayName === "string" && attendee.displayName.trim()) {
            return "display_name:" + attendee.displayName.trim();
          }
          return null;
        }

        function extractAttendeeRecord(attendee, backfilled) {
          if (!attendee || typeof attendee !== "object") {
            return null;
          }
          const attendeeId = buildAttendeeId(attendee);
          if (!attendeeId) {
            return null;
          }
          const payload = {
            attendee_id: attendeeId,
            user_id: toFiniteNumber(attendee.userId),
            display_name: typeof attendee.displayName === "string" ? attendee.displayName : null,
            is_host: Boolean(attendee.isHost),
            is_co_host: Boolean(attendee.bCoHost),
            is_guest: Boolean(attendee.isGuest),
            muted: typeof attendee.muted === "boolean" ? attendee.muted : null,
            video_on: typeof attendee.bVideoOn === "boolean" ? attendee.bVideoOn : null,
            audio_connection: typeof attendee.audio === "string" ? attendee.audio : null,
            last_spoken_at_unix_ms: toFiniteNumber(attendee.lastSpokenTime),
            backfilled,
            details: {
              capture_strategy: "redux_store",
              user_guid: typeof attendee.userGUID === "string" ? attendee.userGUID : null,
              conf_user_id: typeof attendee.strConfUserID === "string" ? attendee.strConfUserID : null,
              zoom_id: typeof attendee.zoomID === "string" ? attendee.zoomID : null,
              unique_index: toFiniteNumber(attendee.uniqueIndex),
              user_role: toFiniteNumber(attendee.userRole),
              audio_connection_status: toFiniteNumber(attendee.audioConnectionStatus),
              participant_id: toFiniteNumber(attendee.participantId),
              device_os: typeof attendee.pwaOS === "string" ? attendee.pwaOS : typeof attendee.os === "string" ? attendee.os : null,
              can_record: toFiniteNumber(attendee.canRecord),
            },
          };
          return {
            attendeeId,
            signature: JSON.stringify({
              display_name: payload.display_name,
              is_host: payload.is_host,
              is_co_host: payload.is_co_host,
              is_guest: payload.is_guest,
              muted: payload.muted,
              video_on: payload.video_on,
              audio_connection: payload.audio_connection,
            }),
            payload,
            raw: attendee,
          };
        }

        function observeAttendeeStore() {
          const store = resolveReduxStore();
          if (!store) {
            return false;
          }
          let initialized = false;
          const processState = () => {
            const attendees = store.getState()?.attendeesList?.attendeesList;
            if (!Array.isArray(attendees)) {
              return;
            }
            const nextAttendeeIds = new Set();
            for (const attendee of attendees) {
              const record = extractAttendeeRecord(attendee, !initialized);
              if (!record) {
                continue;
              }
              nextAttendeeIds.add(record.attendeeId);
              if (!seenAttendees.has(record.attendeeId)) {
                seenAttendees.set(record.attendeeId, record);
                emitDomEvent("zoom.attendee.joined", record.payload, record.raw);
                continue;
              }
              const previousRecord = seenAttendees.get(record.attendeeId);
              seenAttendees.set(record.attendeeId, record);
              if (previousRecord?.signature !== record.signature) {
                continue;
              }
            }
            for (const [attendeeId, record] of seenAttendees.entries()) {
              if (nextAttendeeIds.has(attendeeId)) {
                continue;
              }
              emitDomEvent("zoom.attendee.left", {
                ...record.payload,
                backfilled: false,
              }, record.raw);
              seenAttendees.delete(attendeeId);
            }
            initialized = true;
          };
          processState();
          store.subscribe(processState);
          return true;
        }

        function observeStoreSnapshots() {
          const store = resolveReduxStore();
          if (!store) {
            return false;
          }
          const emitSnapshot = () => {
            const stateSnapshot = store.getState();
            const attendeeCount = Array.isArray(stateSnapshot?.attendeesList?.attendeesList)
              ? stateSnapshot.attendeesList.attendeesList.length
              : null;
            const chatMessages = stateSnapshot?.newChat?.meetingChat
              || stateSnapshot?.chat?.meetingChat
              || null;
            const chatMessageCount = Array.isArray(chatMessages) ? chatMessages.length : null;
            emitDomEvent("zoom.store.snapshot", {
              captured_at_unix_ms: Date.now(),
              capture_strategy: "redux_store",
              top_level_keys: stateSnapshot && typeof stateSnapshot === "object" ? Object.keys(stateSnapshot).sort() : [],
              attendee_count: attendeeCount,
              chat_message_count: chatMessageCount,
            }, stateSnapshot);
          };
          emitSnapshot();
          setInterval(emitSnapshot, 5 * 60 * 1000);
          return true;
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

        observeAttendeeStore();
        observeStoreSnapshots();

        if (!observeChatStore()) {
          void openChatPanel().then(() => {
            const chatPoll = setInterval(() => {
              const chatList = document.querySelector("[class*='chat-container'] [class*='chat-list']")
                || document.querySelector(".chat-container__chat-list");
              if (chatList) {
                observeChatList(chatList);
                clearInterval(chatPoll);
              }
            }, 1500);
          });
        }

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

  window.__meterCapture = {
    start,
    state,
    installCaptureButton,
    buttonId: captureButtonId,
  };
})();
`;
}
