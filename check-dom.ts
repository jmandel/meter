// Quick diagnostic: check active speaker DOM state
const tabs = await fetch("http://localhost:9222/json/list").then(r => r.json());
const page = tabs.find((t: any) => t.type === "page");
if (!page) { console.log("no page"); process.exit(1); }
console.log("Tab:", page.title);

const ws = new WebSocket("ws://localhost:9222/devtools/page/" + page.id);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `JSON.stringify({
        hasMeetingApp: !!document.getElementById("meeting-app"),
        activeFrame: document.querySelector("[class*='video-frame--active']")?.className,
        activeName: document.querySelector("[class*='video-frame--active'] .video-avatar__avatar-name")?.textContent?.trim(),
        allFrameClasses: [...document.querySelectorAll("[class*='video-frame']")].map(e => e.className.substring(0, 100)),
        allAvatarNames: [...document.querySelectorAll(".video-avatar__avatar-name")].map(e => e.textContent?.trim()),
      })`,
      returnByValue: true,
    }
  }));
});
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
  if (msg.id === 1) {
    const val = msg.result?.result?.value;
    if (val) console.log(JSON.stringify(JSON.parse(val), null, 2));
    else console.log(JSON.stringify(msg.result, null, 2));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 3000);
