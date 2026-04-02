import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
    --good: #1f7a4d;
    --highlight: rgba(255, 227, 163, 0.78);
    --shadow: 0 18px 42px rgba(91, 62, 25, 0.08);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background:
      radial-gradient(circle at top left, rgba(211, 106, 46, 0.16), transparent 30%),
      linear-gradient(180deg, #fbf6ee 0%, var(--bg) 100%);
    color: var(--text);
    font-family: "Instrument Sans", "Avenir Next", "Segoe UI", sans-serif;
  }
  .shell {
    max-width: 1120px;
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
    font-size: clamp(1.8rem, 3vw, 2.8rem);
    line-height: 0.96;
    letter-spacing: -0.05em;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
    margin-top: 10px;
  }
  .status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 999px;
    padding: 8px 12px;
    min-width: 132px;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.75;
  }
  .status.live { color: var(--good); }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .action-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
    font-weight: 700;
  }
  .action-link:hover { text-decoration: underline; }
  .panel {
    border-radius: 24px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow);
    padding: 18px 20px 22px;
  }
  .viewer-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    margin-bottom: 16px;
  }
  .viewer-head h2 {
    margin: 0;
    font-size: 1.6rem;
    letter-spacing: -0.04em;
  }
  .viewer-head .meta {
    margin-top: 0;
  }
  .transcript-markdown > :first-child { margin-top: 0; }
  .transcript-markdown > :last-child { margin-bottom: 0; }
  .transcript-markdown h1,
  .transcript-markdown h2,
  .transcript-markdown h3,
  .transcript-markdown h4 {
    letter-spacing: -0.03em;
    margin: 1.25em 0 0.4em;
  }
  .transcript-markdown p,
  .transcript-markdown li,
  .transcript-markdown blockquote,
  .transcript-markdown code {
    font-size: 15px;
    line-height: 1.62;
  }
  .transcript-markdown ul,
  .transcript-markdown ol {
    padding-left: 1.25rem;
  }
  .transcript-markdown blockquote {
    border-left: 3px solid rgba(167, 75, 21, 0.26);
    margin-left: 0;
    padding-left: 14px;
    color: var(--muted);
  }
  .transcript-markdown code {
    background: rgba(60, 39, 19, 0.06);
    padding: 0.08em 0.3em;
    border-radius: 6px;
  }
  @keyframes highlight-fade {
    0% { background: var(--highlight); }
    100% { background: transparent; }
  }
  .diff-new {
    animation: highlight-fade 4s ease-out forwards;
  }
  @media (max-width: 900px) {
    .head, .viewer-head {
      flex-direction: column;
      align-items: flex-start;
    }
    .actions {
      justify-content: flex-start;
    }
  }
`;

interface TranscriptPaths {
  streamPath: string;
  markdownPath: string;
  title: string;
}

function resolvePaths(): TranscriptPaths {
  const search = new URLSearchParams(window.location.search);
  const streamPath = search.get("stream");
  const markdownPath = search.get("markdown");
  const title = search.get("title");
  if (!streamPath || !markdownPath) {
    const current = window.location.pathname;
    const currentSearch = window.location.search;
    const zoomMeetingMatch = current.match(/^\/zoom-meetings\/([^/]+)\/transcript\/view$/);
    if (zoomMeetingMatch) {
      const meetingId = decodeURIComponent(zoomMeetingMatch[1] ?? "");
      return {
        streamPath: `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/stream${currentSearch}`,
        markdownPath: `/v1/zoom-meetings/${encodeURIComponent(meetingId)}/transcript.md${currentSearch}`,
        title: title || "Transcript",
      };
    }
    const meetingRunMatch = current.match(/^\/meeting-runs\/([^/]+)\/transcript\/view$/);
    if (meetingRunMatch) {
      const meetingRunId = decodeURIComponent(meetingRunMatch[1] ?? "");
      return {
        streamPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/stream${currentSearch}`,
        markdownPath: `/v1/meeting-runs/${encodeURIComponent(meetingRunId)}/transcript.md${currentSearch}`,
        title: title || "Transcript",
      };
    }
    throw new Error("Missing transcript viewer parameters");
  }
  return {
    streamPath,
    markdownPath,
    title: title || "Transcript",
  };
}

function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
}

function reconcileRenderedMarkdown(container: HTMLElement, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  const nextChildren = Array.from(template.content.childNodes);
  const currentChildren = Array.from(container.childNodes);
  let prefix = 0;
  while (
    prefix < currentChildren.length
    && prefix < nextChildren.length
    && currentChildren[prefix]?.textContent === nextChildren[prefix]?.textContent
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < currentChildren.length - prefix
    && suffix < nextChildren.length - prefix
    && currentChildren[currentChildren.length - 1 - suffix]?.textContent === nextChildren[nextChildren.length - 1 - suffix]?.textContent
  ) {
    suffix += 1;
  }
  const removeStart = prefix;
  const removeEnd = currentChildren.length - suffix;
  for (let index = removeStart; index < removeEnd; index += 1) {
    currentChildren[index]?.parentNode?.removeChild(currentChildren[index] as ChildNode);
  }
  const insertBefore = container.childNodes[prefix] ?? null;
  for (let index = prefix; index < nextChildren.length - suffix; index += 1) {
    container.insertBefore(nextChildren[index]!.cloneNode(true), insertBefore);
  }
}

function applyHighlights(container: HTMLElement, previousLeafTexts: string[]): string[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as HTMLElement;
      return element.children.length === 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nextLeafTexts: string[] = [];
  let index = 0;
  while (walker.nextNode()) {
    const element = walker.currentNode as HTMLElement;
    const text = (element.textContent || "").trim();
    if (!text) {
      continue;
    }
    nextLeafTexts.push(text);
    element.classList.remove("diff-new");
    void element.offsetWidth;
    if (previousLeafTexts[index] !== text) {
      element.classList.add("diff-new");
    }
    index += 1;
  }
  return nextLeafTexts;
}

export function TranscriptPage() {
  const paths = useMemo(() => resolvePaths(), []);
  const [content, setContent] = useState("");
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "error">("connecting");
  const [updatedLabel, setUpdatedLabel] = useState<string>("Waiting for transcript...");
  const contentRootRef = useRef<HTMLDivElement | null>(null);
  const lastMarkdownRef = useRef("");
  const previousLeafTextsRef = useRef<string[]>([]);
  const autoTailRef = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120;
      autoTailRef.current = nearBottom;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const applyIncomingMarkdown = (markdown: string, label: string) => {
    if (!markdown.trim()) {
      return;
    }
    lastMarkdownRef.current = markdown;
    setContent(markdown);
    setUpdatedLabel(label);
    setConnectionState("live");
  };

  useLayoutEffect(() => {
    const container = contentRootRef.current;
    if (!container) {
      return;
    }
    const rendered = renderMarkdown(content);
    reconcileRenderedMarkdown(container, rendered);
    previousLeafTextsRef.current = applyHighlights(container, previousLeafTextsRef.current);
    if (autoTailRef.current) {
      requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
    }
  }, [content]);

  useEffect(() => {
    let cancelled = false;
    let eventSource: EventSource | null = null;

    const fetchMarkdown = async (reason: string) => {
      try {
        const response = await fetch(paths.markdownPath, { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const markdown = await response.text();
        if (cancelled || !markdown.trim() || markdown === lastMarkdownRef.current) {
          return;
        }
        applyIncomingMarkdown(markdown, reason);
      } catch {
        if (!cancelled) {
          setConnectionState("error");
        }
      }
    };

    void fetchMarkdown(`Loaded ${new Date().toLocaleString()}`);

    try {
      eventSource = new EventSource(paths.streamPath);
      eventSource.addEventListener("open", () => setConnectionState("live"));
      eventSource.addEventListener("error", () => setConnectionState("error"));
      eventSource.addEventListener("event", () => {
        void fetchMarkdown(`Updated ${new Date().toLocaleString()}`);
      });
      eventSource.addEventListener("heartbeat", () => {
        if (!cancelled && connectionState !== "live") {
          setConnectionState("live");
        }
      });
    } catch {
      setConnectionState("error");
    }

    const interval = window.setInterval(() => {
      void fetchMarkdown(`Updated ${new Date().toLocaleString()}`);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      eventSource?.close();
    };
  }, [paths.markdownPath, paths.streamPath]);

  return (
    <>
      <style>{styles}</style>
      <main className="shell">
        <header className="head">
          <div>
            <p className="eyebrow">Transcript Viewer</p>
            <h1>{paths.title}</h1>
            <div className="meta">
              <span>{updatedLabel}</span>
            </div>
          </div>
          <div className="actions">
            <a className="action-link" href="/">Back to dashboard</a>
            <a className="action-link" href={paths.markdownPath} target="_blank" rel="noreferrer">Open raw markdown</a>
            <div className={`status ${connectionState === "live" ? "live" : ""}`}>
              <span className="status-dot" />
              {connectionState === "connecting" ? "Connecting" : connectionState === "live" ? "Live" : "Reconnecting"}
            </div>
          </div>
        </header>
        <section className="panel">
          <div className="viewer-head">
            <h2>Live transcript</h2>
          </div>
          <div className="transcript-markdown" ref={contentRootRef} />
        </section>
      </main>
    </>
  );
}
