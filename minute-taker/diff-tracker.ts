export interface CursorTracker {
  cursor: string | null;
  segmentIndex: number;
  lastContent: string | null;
}

export interface TranscriptChunk {
  segmentIndex: number;
  content: string;
  cursor: string | null;
  isFirst: boolean;
}

// Matches lines like [00:24 spk=...], [01:30:45 chat ...], [00:05 joins], etc.
const TIMESTAMP_LINE_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\s/;
const TIMESTAMP_LINE_RE_MULTILINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\s/m;

export function createTracker(): CursorTracker {
  return { cursor: null, segmentIndex: 0, lastContent: null };
}

/**
 * Extract the timestamp prefix from the last transcript line,
 * e.g. "00:24" from `[00:24 spk="Name"] text`.
 */
function extractLastTimestamp(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = TIMESTAMP_LINE_RE.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

/**
 * Check if a transcript response has meaningful content
 * (not just header/boilerplate with no actual entries).
 */
function hasContent(text: string): boolean {
  if (/_No .+ entries/.test(text)) return false;
  return TIMESTAMP_LINE_RE_MULTILINE.test(text);
}

/**
 * Process a transcript API response. Returns a chunk if there's new content,
 * or null if nothing new. Updates the tracker's cursor for the next fetch.
 */
export function processResponse(
  tracker: CursorTracker,
  responseText: string,
): TranscriptChunk | null {
  if (!hasContent(responseText)) return null;
  if (tracker.lastContent === responseText) return null;

  const cursor = extractLastTimestamp(responseText);
  if (cursor) {
    tracker.cursor = cursor;
  }
  tracker.lastContent = responseText;

  const isFirst = tracker.segmentIndex === 0;
  tracker.segmentIndex += 1;

  return {
    segmentIndex: tracker.segmentIndex,
    content: responseText,
    cursor,
    isFirst,
  };
}
