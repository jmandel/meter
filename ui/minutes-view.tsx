import { marked } from "marked";

const styles = `
  :root {
    color-scheme: light;
    --bg: #f6efe4;
    --surface: rgba(255, 252, 247, 0.96);
    --border: rgba(69, 51, 33, 0.12);
    --text: #241c14;
    --muted: #6d5e4a;
    --accent: #a74b15;
    --highlight: rgba(255, 227, 163, 0.78);
    --good: #1f7a4d;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(211, 106, 46, 0.16), transparent 30%),
      linear-gradient(180deg, #fbf6ee 0%, var(--bg) 100%);
    color: var(--text);
    font-family: "Instrument Sans", "Avenir Next", "Segoe UI", sans-serif;
  }

  .shell {
    max-width: 980px;
    margin: 0 auto;
    padding: 28px 20px 56px;
  }

  .head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 18px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 11px;
    font-weight: 800;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.8rem, 3vw, 2.6rem);
    line-height: 0.96;
    letter-spacing: -0.05em;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--muted);
    font-size: 13px;
    margin-top: 10px;
  }

  .actions {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .action {
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
    font-weight: 700;
  }

  .action:hover {
    text-decoration: underline;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 999px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #c8b8a0;
  }

  .status-live .status-dot {
    background: var(--good);
  }

  .status-reconnecting .status-dot {
    background: #d36a2e;
  }

  .content {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 24px 28px;
    box-shadow: 0 18px 42px rgba(91, 62, 25, 0.08);
    line-height: 1.65;
  }

  .content > :first-child {
    margin-top: 0;
  }

  .content > :last-child {
    margin-bottom: 0;
  }

  .content h1, .content h2, .content h3, .content h4 {
    line-height: 1.2;
    color: #17130e;
  }

  .content h1 { font-size: 2rem; }
  .content h2 { margin-top: 2rem; padding-bottom: 6px; border-bottom: 1px solid rgba(69, 51, 33, 0.08); }
  .content code {
    background: rgba(235, 221, 202, 0.8);
    padding: 2px 6px;
    border-radius: 6px;
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  }

  .content pre {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .content blockquote {
    margin-left: 0;
    padding-left: 14px;
    border-left: 3px solid rgba(211, 106, 46, 0.24);
    color: var(--muted);
  }

  .empty {
    color: var(--muted);
    border: 1px dashed rgba(69, 51, 33, 0.16);
    border-radius: 18px;
    padding: 28px;
    text-align: center;
    background: rgba(255, 255, 255, 0.54);
  }

  @keyframes highlight-fade {
    0% { background-color: var(--highlight); }
    100% { background-color: transparent; }
  }

  .diff-new {
    animation: highlight-fade 4s ease-out forwards;
    border-radius: 4px;
  }
`;

type StreamPayload = {
  minute_job: {
    minute_job_id: string;
    state: string;
  };
  version: {
    minute_version_id: string;
    seq: number;
    status: string;
    created_at: string;
  };
  content_markdown: string;
};

function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.appendChild(style);
}

function getPaths() {
  const search = new URLSearchParams(window.location.search);
  const streamPath = search.get("stream");
  const markdownPath = search.get("markdown");
  const title = search.get("title");
  if (streamPath && markdownPath) {
    return { streamPath, markdownPath, title };
  }
  const current = `${window.location.pathname}${window.location.search}`;
  return {
    streamPath: current.replace(/\/view(\?.*)?$/, "/stream$1"),
    markdownPath: current.replace(/\/view(\?.*)?$/, ".md$1"),
    title: null,
  };
}

function getLeafNodes(container: Element): string[] {
  const nodes: string[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;
  while (current) {
    const tagName = current.tagName;
    if (["P", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "PRE", "TD"].includes(tagName)) {
      const text = current.textContent?.trim();
      if (text) {
        nodes.push(text);
      }
    }
    current = walker.nextNode() as Element | null;
  }
  return nodes;
}

function setStatus(root: HTMLElement, label: string, tone: "idle" | "live" | "reconnecting"): void {
  const status = root.querySelector<HTMLElement>("[data-role='status']");
  if (!status) {
    return;
  }
  status.className = `status status-${tone}`;
  status.querySelector<HTMLElement>("[data-role='status-label']")!.textContent = label;
}

function renderShell(): HTMLElement {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing #root");
  }

  root.innerHTML = `
    <main class="shell">
      <header class="head">
        <div>
          <p class="eyebrow">Live Minutes</p>
          <h1>Meter Minutes</h1>
          <div class="meta">
            <span data-role="updated">Waiting for first update…</span>
          </div>
        </div>
        <div class="actions">
          <a class="action" data-role="markdown-link" href="#" target="_blank" rel="noreferrer">Open raw markdown</a>
          <div class="status status-idle" data-role="status">
            <span class="status-dot"></span>
            <span data-role="status-label">Connecting</span>
          </div>
        </div>
      </header>
      <section class="content" data-role="content">
        <div class="empty">Waiting for minutes…</div>
      </section>
    </main>
  `;
  return root;
}

function applyMarkdown(contentEl: HTMLElement, markdown: string, previousLeafTexts: Set<string>): Set<string> {
  const html = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  contentEl.innerHTML = html;
  const nextLeafTexts = new Set(getLeafNodes(contentEl));
  const candidates = contentEl.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,td");
  for (const element of candidates) {
    const text = element.textContent?.trim();
    if (text && !previousLeafTexts.has(text)) {
      element.classList.add("diff-new");
    }
  }
  return nextLeafTexts;
}

function start(): void {
  injectStyles();
  const root = renderShell();
  const contentEl = root.querySelector<HTMLElement>("[data-role='content']")!;
  const updatedEl = root.querySelector<HTMLElement>("[data-role='updated']")!;
  const markdownLink = root.querySelector<HTMLAnchorElement>("[data-role='markdown-link']")!;
  const { streamPath, markdownPath, title } = getPaths();
  markdownLink.href = markdownPath;
  if (title) {
    const heading = root.querySelector("h1");
    if (heading) {
      heading.textContent = title;
    }
    document.title = `${title} Minutes`;
  }

  let lastLeafTexts = new Set<string>();
  let lastMarkdown = "";

  const eventSource = new EventSource(streamPath);

  eventSource.onopen = () => {
    setStatus(root, "Live", "live");
  };

  eventSource.onerror = () => {
    setStatus(root, "Reconnecting", "reconnecting");
  };

  eventSource.addEventListener("heartbeat", () => {
    setStatus(root, "Live", "live");
  });

  eventSource.addEventListener("minutes", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as StreamPayload;
    setStatus(root, payload.version.status === "final" ? "Finalized" : "Live", "live");
    updatedEl.textContent = `Updated ${new Date(payload.version.created_at).toLocaleString()} · version ${payload.version.seq}`;
    if (payload.content_markdown === lastMarkdown) {
      return;
    }
    lastMarkdown = payload.content_markdown;
    const previous = new Set(lastLeafTexts);
    lastLeafTexts = applyMarkdown(contentEl, payload.content_markdown, previous);
  });
}

start();
