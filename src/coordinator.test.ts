import { expect, test } from "bun:test";

import { CoordinatorApp } from "./coordinator";
import type {
  ChatMessageRecord,
  InternalConfig,
  MeetingRunRecord,
  SpeechSegmentRecord,
} from "./domain";

function buildConfig(): InternalConfig {
  return {
    mode: "all",
    public_base_url: "",
    listen_host: "127.0.0.1",
    listen_port: 3100,
    data_root: "/tmp/meter-test",
    chrome_bin: "chromium",
    default_bot_name: "Meeting Bot",
    transcription_provider: "mistral",
    persist_live_pcm: false,
    persist_archive_audio: true,
    archive_chunk_ms: 5000,
    live_pcm_chunk_ms: 480,
    sqlite_path: "/tmp/meter-test.sqlite",
    coordinator_base_url: "http://127.0.0.1:3100",
    coordinator_token: "test-token",
    heartbeat_interval_ms: 5000,
  };
}

function buildMeetingRun(): MeetingRunRecord {
  return {
    meeting_run_id: "meeting-run-test",
    room_id: "zoom:2193058682",
    source: "zoom",
    normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
    bot_name: "Meeting Bot",
    requested_by: null,
    tags: [],
    state: "capturing",
    started_at: "2026-03-12T06:48:00.000Z",
    ended_at: null,
    created_at: "2026-03-12T06:48:00.000Z",
    updated_at: "2026-03-12T06:48:05.000Z",
    worker: null,
    paths: {
      data_dir: "/tmp/meter-test",
      event_journal_path: "/tmp/meter-test/events.ndjson",
      archive_audio_dir: "/tmp/meter-test/audio",
      live_pcm_dir: null,
      worker_log_path: "/tmp/meter-test/worker.log",
      browser_log_path: "/tmp/meter-test/browser.log",
    },
    options: {
      open_chat_panel: true,
      enable_transcription: true,
      enable_speaker_tracking: true,
      enable_chat_tracking: true,
      persist_archive_audio: true,
      persist_live_pcm: false,
      archive_chunk_ms: 5000,
      live_pcm_chunk_ms: 480,
      auto_stop_when_meeting_ends: true,
    },
    stats: {
      event_count: 0,
      speech_segment_count: 0,
      chat_message_count: 0,
      audio_object_count: 0,
      archive_audio_bytes: 0,
    },
    last_error: null,
  };
}

function buildSpeech(): SpeechSegmentRecord[] {
  return [
    {
      speech_segment_id: "seg-1",
      event_id: 1,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-1",
      text: "Opening remarks",
      status: "final",
      speaker_label: "Judge mobile",
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:10.000Z",
      ended_at: "2026-03-12T06:48:12.000Z",
      emitted_at: "2026-03-12T06:48:12.100Z",
    },
    {
      speech_segment_id: "seg-2",
      event_id: 2,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-2",
      text: "Follow up",
      status: "final",
      speaker_label: "Josh Mandel",
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:30.000Z",
      ended_at: "2026-03-12T06:48:31.000Z",
      emitted_at: "2026-03-12T06:48:31.100Z",
    },
  ];
}

function buildChat(): ChatMessageRecord[] {
  return [
    {
      chat_message_id: "chat-root",
      event_id: 3,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      sender_display_name: "Judge mobile",
      sender_user_id: 123,
      receiver_display_name: "Everyone",
      receiver_user_id: 0,
      visibility: "everyone",
      text: "Ahoy",
      sent_at: "2026-03-12T06:48:20.000Z",
      main_chat_message_id: null,
      thread_reply_count: 1,
      is_thread_reply: false,
      is_edited: false,
      chat_type: "groupchat",
      details: null,
    },
    {
      chat_message_id: "chat-reply",
      event_id: 4,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      sender_display_name: "Josh Mandel",
      sender_user_id: 456,
      receiver_display_name: "Everyone",
      receiver_user_id: 0,
      visibility: "everyone",
      text: "Reply text",
      sent_at: "2026-03-12T06:48:21.000Z",
      main_chat_message_id: "chat-root",
      thread_reply_count: 0,
      is_thread_reply: true,
      is_edited: false,
      chat_type: "groupchat",
      details: null,
    },
  ];
}

test("renderMarkdownTranscript keeps default output speech only", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    includeChat?: boolean,
  ) => string;

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeech(), buildChat(), false);

  expect(markdown).toContain("## Transcript");
  expect(markdown).toContain("Opening remarks");
  expect(markdown).not.toContain("[Chat]");
  expect(markdown).not.toContain("Reply text");
});

test("renderMarkdownTranscript can interleave chat entries", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    includeChat?: boolean,
  ) => string;

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeech(), buildChat(), true);

  expect(markdown).toContain("[Chat] Judge mobile -> Everyone (1 reply)");
  expect(markdown).toContain("[Chat] Josh Mandel -> Everyone (reply to chat-root)");
  expect(markdown).toContain("Reply text");
  expect(markdown.indexOf("Opening remarks")).toBeLessThan(markdown.indexOf("Ahoy"));
  expect(markdown.indexOf("Ahoy")).toBeLessThan(markdown.indexOf("Reply text"));
  expect(markdown.indexOf("Reply text")).toBeLessThan(markdown.indexOf("Follow up"));
});
