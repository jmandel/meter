#!/usr/bin/env bun

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const key = Bun.argv[i];
  if (!key.startsWith("--")) continue;
  const next = Bun.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, "true");
  }
}

const minutesRoot = resolve(args.get("--minutes-root") ?? "./minutes");
const port = parseInt(args.get("--port") ?? "3200", 10);

// Find run dir by meeting-id (latest matching), meeting-run-id, or explicit path
function findRunDir(): string | null {
  const meetingId = args.get("--meeting-id");
  const runId = args.get("--meeting-run-id");
  const explicit = args.get("--dir");

  if (explicit) return resolve(explicit);

  if (!existsSync(minutesRoot)) return null;

  const dirs = readdirSync(minutesRoot)
    .filter((d) => {
      const full = join(minutesRoot, d);
      return statSync(full).isDirectory();
    })
    .sort()
    .reverse(); // newest first (dirs contain run ID prefix which sorts chronologically)

  if (runId) {
    const shortId = runId.slice(0, 8);
    const match = dirs.find((d) => d.includes(shortId));
    return match ? join(minutesRoot, match) : null;
  }

  if (meetingId) {
    const match = dirs.find((d) => d.startsWith(`${meetingId}-`));
    return match ? join(minutesRoot, match) : null;
  }

  // Default: latest
  return dirs[0] ? join(minutesRoot, dirs[0]) : null;
}

function listRuns(): { name: string; hasMinutes: boolean; mtime: Date }[] {
  if (!existsSync(minutesRoot)) return [];
  return readdirSync(minutesRoot)
    .filter((d) => statSync(join(minutesRoot, d)).isDirectory())
    .map((d) => ({
      name: d,
      hasMinutes: existsSync(join(minutesRoot, d, "minutes.md")),
      mtime: statSync(join(minutesRoot, d)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function renderListPage(): string {
  const runs = listRuns();
  const rows = runs
    .map(
      (r) =>
        `<tr>
      <td><a href="/run/${r.name}">${r.name}</a></td>
      <td>${r.hasMinutes ? "yes" : "waiting..."}</td>
      <td>${r.mtime.toLocaleString()}</td>
    </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Minutes Runs</title>
<style>
  body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, system-ui, sans-serif; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head><body>
<h1>Meeting Minutes</h1>
${runs.length === 0 ? "<p>No runs yet.</p>" : `<table><tr><th>Run</th><th>Minutes</th><th>Last Modified</th></tr>${rows}</table>`}
<script>setTimeout(() => location.reload(), 5000);</script>
</body></html>`;
}

const previewHtml = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Minutes Preview</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, system-ui, sans-serif; line-height: 1.6; color: #333; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: 8px; }
  h2 { border-bottom: 1px solid #eee; padding-bottom: 4px; margin-top: 2em; }
  h3 { margin-top: 1.5em; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
  ul { padding-left: 1.5em; }
  li { margin: 4px 0; }
  #status { position: fixed; top: 8px; right: 12px; font-size: 12px; color: #999; }
  #back { position: fixed; top: 8px; left: 12px; font-size: 13px; }
  #back a { color: #2563eb; text-decoration: none; }
  @keyframes highlight-fade {
    0% { background-color: #fef3c7; }
    100% { background-color: transparent; }
  }
  .diff-new {
    animation: highlight-fade 4s ease-out forwards;
    border-radius: 3px;
  }
</style>
</head><body>
<div id="back"><a href="/">&larr; all runs</a></div>
<div id="status"></div>
<div id="content"><em>Waiting for minutes.md...</em></div>
<script>
const runName = location.pathname.replace(/^\\/run\\//, "").replace(/\\/$/, "");
let lastContent = "";
let lastNodes = [];

function getLeafNodes(el) {
  const nodes = [];
  for (const child of el.children) {
    if (child.children.length === 0 || child.tagName === "LI" || child.tagName === "P") {
      nodes.push({ text: child.textContent.trim(), tag: child.tagName });
    } else {
      nodes.push(...getLeafNodes(child));
    }
  }
  return nodes;
}

async function refresh() {
  try {
    const res = await fetch("/raw/" + runName);
    const text = await res.text();
    if (text !== lastContent) {
      const wasAtBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
      const container = document.getElementById("content");
      const oldTexts = new Set(lastNodes.map(n => n.text));

      lastContent = text;
      container.innerHTML = marked.parse(text);

      const newNodes = getLeafNodes(container);
      lastNodes = newNodes;

      const allEls = container.querySelectorAll("h1,h2,h3,h4,p,li,tr,blockquote");
      for (const el of allEls) {
        const t = el.textContent.trim();
        if (t && !oldTexts.has(t)) {
          el.classList.add("diff-new");
        }
      }

      document.getElementById("status").textContent = "Updated " + new Date().toLocaleTimeString();
      if (wasAtBottom) window.scrollTo(0, document.body.scrollHeight);
    }
  } catch {}
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    // Serve raw minutes for a specific run
    const rawMatch = url.pathname.match(/^\/raw\/(.+)/);
    if (rawMatch) {
      const runDir = join(minutesRoot, rawMatch[1]);
      const minutesPath = join(runDir, "minutes.md");
      try {
        const text = readFileSync(minutesPath, "utf-8");
        return new Response(text, { headers: { "content-type": "text/plain" } });
      } catch {
        return new Response("_No minutes.md yet._", { headers: { "content-type": "text/plain" } });
      }
    }

    // Serve preview page for a specific run
    const runMatch = url.pathname.match(/^\/run\/(.+)/);
    if (runMatch) {
      return new Response(previewHtml, { headers: { "content-type": "text/html" } });
    }

    // If launched with a specific run arg, redirect to it
    if (url.pathname === "/") {
      const dir = findRunDir();
      if (dir && (args.has("--meeting-id") || args.has("--meeting-run-id") || args.has("--dir"))) {
        const name = basename(dir);
        return Response.redirect(`/run/${name}`, 302);
      }
      // Otherwise show listing
      return new Response(renderListPage(), { headers: { "content-type": "text/html" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Preview: http://127.0.0.1:${port}`);
console.log(`Minutes root: ${minutesRoot}`);
if (args.has("--meeting-id") || args.has("--meeting-run-id")) {
  const dir = findRunDir();
  if (dir) console.log(`Auto-opening: ${basename(dir)}`);
}
