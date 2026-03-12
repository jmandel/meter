export interface SpeechSegmentRecord {
  speech_segment_id: string;
  text: string;
  status: "partial" | "final";
  speaker_label: string | null;
  started_at: string | null;
  ended_at: string | null;
  emitted_at: string;
}

export interface TranscriptEntry {
  row_id: string;
  speaker_label: string | null;
  started_at: string | null;
  updated_at: string;
  committed_text: string;
  live_text: string;
  status: "streaming" | "final";
  partial_segment_id: string | null;
}

const MAX_TRANSCRIPT_ROWS = 8;
const TRANSCRIPT_MERGE_WINDOW_MS = 20_000;

function normalizeSpeakerLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function segmentAnchorIso(segment: SpeechSegmentRecord): string {
  return segment.emitted_at;
}

export function joinTranscriptText(left: string, right: string): string {
  const start = left.trim();
  const end = right.trim();
  if (!start) {
    return end;
  }
  if (!end) {
    return start;
  }
  if (start.endsWith("-") || /^[,.;:!?)]/.test(end)) {
    return `${start}${end}`;
  }
  return `${start} ${end}`;
}

export function transcriptEntryText(entry: TranscriptEntry): string {
  return joinTranscriptText(entry.committed_text, entry.live_text);
}

function shouldMergeTranscriptEntry(entry: TranscriptEntry, segment: SpeechSegmentRecord): boolean {
  const entrySpeaker = normalizeSpeakerLabel(entry.speaker_label);
  const segmentSpeaker = normalizeSpeakerLabel(segment.speaker_label);
  const anchorIso = entry.updated_at || entry.started_at;
  const segmentIso = segmentAnchorIso(segment);
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  const segmentMs = Date.parse(segmentIso);
  const inWindow = !Number.isFinite(anchorMs) || !Number.isFinite(segmentMs)
    ? true
    : Math.abs(segmentMs - anchorMs) <= TRANSCRIPT_MERGE_WINDOW_MS;
  if (!inWindow) {
    return false;
  }
  if (entry.status === "streaming") {
    return entrySpeaker === segmentSpeaker || !entrySpeaker || !segmentSpeaker;
  }
  if (!entrySpeaker || !segmentSpeaker) {
    return false;
  }
  return entrySpeaker === segmentSpeaker;
}

function trimTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.slice(-MAX_TRANSCRIPT_ROWS);
}

export function appendTranscriptEvent(entries: TranscriptEntry[], segment: SpeechSegmentRecord): TranscriptEntry[] {
  const nextEntries = [...entries];
  const lastEntry = nextEntries[nextEntries.length - 1];

  if (segment.status === "partial") {
    const existingIndex = nextEntries.findIndex((entry) => entry.partial_segment_id === segment.speech_segment_id);
    if (existingIndex >= 0) {
      const entry = nextEntries[existingIndex];
      entry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? entry.speaker_label;
      entry.started_at = entry.started_at ?? segmentAnchorIso(segment);
      entry.updated_at = segment.emitted_at;
      entry.live_text = segment.text;
      entry.status = "streaming";
      return trimTranscriptEntries(nextEntries);
    }

    if (lastEntry && shouldMergeTranscriptEntry(lastEntry, segment)) {
      if (lastEntry.partial_segment_id && lastEntry.partial_segment_id !== segment.speech_segment_id && lastEntry.live_text) {
        lastEntry.committed_text = joinTranscriptText(lastEntry.committed_text, lastEntry.live_text);
      }
      lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
      lastEntry.started_at = lastEntry.started_at ?? segmentAnchorIso(segment);
      lastEntry.updated_at = segment.emitted_at;
      lastEntry.partial_segment_id = segment.speech_segment_id;
      lastEntry.live_text = segment.text;
      lastEntry.status = "streaming";
      return trimTranscriptEntries(nextEntries);
    }

    nextEntries.push({
      row_id: segment.speech_segment_id,
      speaker_label: normalizeSpeakerLabel(segment.speaker_label),
      started_at: segmentAnchorIso(segment),
      updated_at: segment.emitted_at,
      committed_text: "",
      live_text: segment.text,
      status: "streaming",
      partial_segment_id: segment.speech_segment_id,
    });
    return trimTranscriptEntries(nextEntries);
  }

  if (lastEntry && lastEntry.status === "streaming" && shouldMergeTranscriptEntry(lastEntry, segment)) {
    lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
    lastEntry.started_at = lastEntry.started_at ?? segmentAnchorIso(segment);
    lastEntry.updated_at = segment.emitted_at;
    lastEntry.committed_text = joinTranscriptText(lastEntry.committed_text, segment.text);
    lastEntry.live_text = "";
    lastEntry.partial_segment_id = null;
    lastEntry.status = "final";
    return trimTranscriptEntries(nextEntries);
  }

  if (lastEntry && shouldMergeTranscriptEntry(lastEntry, segment)) {
    lastEntry.speaker_label = normalizeSpeakerLabel(segment.speaker_label) ?? lastEntry.speaker_label;
    lastEntry.started_at = lastEntry.started_at ?? segmentAnchorIso(segment);
    lastEntry.updated_at = segment.emitted_at;
    lastEntry.committed_text = joinTranscriptText(transcriptEntryText(lastEntry), segment.text);
    lastEntry.live_text = "";
    lastEntry.partial_segment_id = null;
    lastEntry.status = "final";
    return trimTranscriptEntries(nextEntries);
  }

  nextEntries.push({
    row_id: segment.speech_segment_id,
    speaker_label: normalizeSpeakerLabel(segment.speaker_label),
    started_at: segmentAnchorIso(segment),
    updated_at: segment.emitted_at,
    committed_text: segment.text,
    live_text: "",
    status: "final",
    partial_segment_id: null,
  });
  return trimTranscriptEntries(nextEntries);
}

export function buildTranscriptPreview(segments: SpeechSegmentRecord[]): TranscriptEntry[] {
  return segments.reduce<TranscriptEntry[]>((entries, segment) => appendTranscriptEvent(entries, segment), []);
}

export function normalizeTranscriptSpeaker(value: string | null | undefined): string | null {
  return normalizeSpeakerLabel(value);
}
