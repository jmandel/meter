// Inject fixed speaker + chat observer into the live Zoom session
const tabs = await fetch("http://localhost:9222/json/list").then(r => r.json());
const page = tabs.find((t: any) => t.type === "page" && t.title.includes("Meeting"));
if (!page) { console.log("no meeting tab"); process.exit(1); }
console.log("Found:", page.id, page.title);

const ws = new WebSocket("ws://localhost:9222/devtools/page/" + page.id);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `
        (async () => {
          const sendWs = window.__captureWs;
          if (!sendWs || sendWs.readyState !== WebSocket.OPEN) return "no ws open";

          // ── Speaker detection ──
          let currentSpeaker = null;
          function checkSpeaker() {
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

          const meetingApp = document.getElementById("meeting-app");
          if (meetingApp) {
            new MutationObserver(() => checkSpeaker()).observe(meetingApp, {
              attributes: true, attributeFilter: ["class"], subtree: true, childList: true,
            });
          }
          setInterval(checkSpeaker, 1000);
          checkSpeaker();

          // ── Chat detection ──
          const seenChat = new Set();
          function tryObserveChat() {
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

          let chatOk = false;
          const chatPoll = setInterval(() => {
            if (!chatOk) chatOk = tryObserveChat();
            if (chatOk) clearInterval(chatPoll);
          }, 2000);

          return "observers-v2-injected";
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    }
  }));
});

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
  if (msg.id === 1) {
    console.log("Result:", msg.result?.result?.value || JSON.stringify(msg.result));
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => { console.log("timeout"); process.exit(1); }, 5000);
