import { expect, test } from "bun:test";

import {
  appendTranscriptEvent,
  buildTranscriptPreview,
  transcriptEntryText,
  type SpeechSegmentRecord,
} from "./transcript";

test("live transcript coalesces consecutive same-speaker chunks even when partial started_at is stale", () => {
  const baseStartedAt = "2026-03-12T06:17:57.329Z";
  const segments: SpeechSegmentRecord[] = [
    {
      speech_segment_id: "judge-partial",
      text: "Josh Mandel's joined the house.",
      status: "partial",
      speaker_label: "Judge mobile",
      started_at: baseStartedAt,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:29.857Z",
    },
    {
      speech_segment_id: "judge-final",
      text: "Josh Mandel's joined the house.",
      status: "final",
      speaker_label: "Judge mobile",
      started_at: null,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:29.905Z",
    },
    {
      speech_segment_id: "josh-partial-1",
      text: "Joshman.",
      status: "partial",
      speaker_label: "Josh Mandel",
      started_at: baseStartedAt,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:31.316Z",
    },
    {
      speech_segment_id: "josh-final-1",
      text: "Joshman.",
      status: "final",
      speaker_label: "Josh Mandel",
      started_at: null,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:31.359Z",
    },
    {
      speech_segment_id: "josh-partial-2",
      text: "Ella's here in the house.",
      status: "partial",
      speaker_label: "Josh Mandel",
      started_at: baseStartedAt,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:32.807Z",
    },
    {
      speech_segment_id: "josh-final-2",
      text: "Ella's here in the house.",
      status: "final",
      speaker_label: "Josh Mandel",
      started_at: null,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:32.857Z",
    },
  ];

  const entries = buildTranscriptPreview(segments);
  expect(entries).toHaveLength(2);
  expect(entries[0].speaker_label).toBe("Judge mobile");
  expect(transcriptEntryText(entries[0])).toBe("Josh Mandel's joined the house.");
  expect(entries[1].speaker_label).toBe("Josh Mandel");
  expect(transcriptEntryText(entries[1])).toBe("Joshman. Ella's here in the house.");
  expect(entries[1].started_at).toBe("2026-03-12T06:18:31.316Z");
});

test("live transcript keeps extending a current same-speaker row across repeated finals", () => {
  let entries = [] as ReturnType<typeof buildTranscriptPreview>;
  const speaker = "Josh Mandel";
  const startedAt = "2026-03-12T06:17:57.329Z";
  const chunks: SpeechSegmentRecord[] = [
    {
      speech_segment_id: "partial-1",
      text: "Okay, that was",
      status: "partial",
      speaker_label: speaker,
      started_at: startedAt,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:45.937Z",
    },
    {
      speech_segment_id: "final-1",
      text: "Okay, that was",
      status: "final",
      speaker_label: speaker,
      started_at: null,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:46.005Z",
    },
    {
      speech_segment_id: "partial-2",
      text: "Overall, quite a bit better, though.",
      status: "partial",
      speaker_label: speaker,
      started_at: startedAt,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:47.427Z",
    },
    {
      speech_segment_id: "final-2",
      text: "Overall, quite a bit better, though.",
      status: "final",
      speaker_label: speaker,
      started_at: null,
      ended_at: null,
      emitted_at: "2026-03-12T06:18:47.494Z",
    },
  ];

  for (const chunk of chunks) {
    entries = appendTranscriptEvent(entries, chunk);
  }

  expect(entries).toHaveLength(1);
  expect(entries[0].speaker_label).toBe(speaker);
  expect(transcriptEntryText(entries[0])).toBe("Okay, that was Overall, quite a bit better, though.");
  expect(entries[0].started_at).toBe("2026-03-12T06:18:45.937Z");
});
