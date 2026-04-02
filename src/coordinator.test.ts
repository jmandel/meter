import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";

import { CoordinatorApp } from "./coordinator";
import { createMeetingRunLayout } from "./files";
import type {
  AttendeeSummaryRecord,
  ChatMessageRecord,
  EventRecord,
  InternalConfig,
  MeetingRunRecord,
  SpeechSegmentRecord,
  ZoomAttendeePresencePayload,
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

function buildTempConfig(tempDir: string): InternalConfig {
  return {
    ...buildConfig(),
    listen_port: 0,
    data_root: tempDir,
    sqlite_path: path.join(tempDir, "index.sqlite"),
    coordinator_base_url: "http://127.0.0.1:0",
  };
}

interface AuthEnvSnapshot {
  adminPassword: string | undefined;
  adminPasswordHash: string | undefined;
  viewerPassword: string | undefined;
  viewerPasswordHash: string | undefined;
  requireReadAuth: string | undefined;
}

function captureAuthEnv(): AuthEnvSnapshot {
  return {
    adminPassword: process.env.METER_ADMIN_PASSWORD,
    adminPasswordHash: process.env.METER_ADMIN_PASSWORD_HASH,
    viewerPassword: process.env.METER_VIEWER_PASSWORD,
    viewerPasswordHash: process.env.METER_VIEWER_PASSWORD_HASH,
    requireReadAuth: process.env.METER_REQUIRE_AUTH_FOR_READS,
  };
}

function restoreAuthEnv(snapshot: AuthEnvSnapshot): void {
  if (snapshot.adminPassword === undefined) delete process.env.METER_ADMIN_PASSWORD;
  else process.env.METER_ADMIN_PASSWORD = snapshot.adminPassword;

  if (snapshot.adminPasswordHash === undefined) delete process.env.METER_ADMIN_PASSWORD_HASH;
  else process.env.METER_ADMIN_PASSWORD_HASH = snapshot.adminPasswordHash;

  if (snapshot.viewerPassword === undefined) delete process.env.METER_VIEWER_PASSWORD;
  else process.env.METER_VIEWER_PASSWORD = snapshot.viewerPassword;

  if (snapshot.viewerPasswordHash === undefined) delete process.env.METER_VIEWER_PASSWORD_HASH;
  else process.env.METER_VIEWER_PASSWORD_HASH = snapshot.viewerPasswordHash;

  if (snapshot.requireReadAuth === undefined) delete process.env.METER_REQUIRE_AUTH_FOR_READS;
  else process.env.METER_REQUIRE_AUTH_FOR_READS = snapshot.requireReadAuth;
}

function buildMeetingRun(overrides: Partial<MeetingRunRecord> = {}): MeetingRunRecord {
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
    ...overrides,
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

function buildSpeechWithGrowingTurn(): SpeechSegmentRecord[] {
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
      speech_segment_id: "seg-1b",
      event_id: 2,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-1b",
      text: "continued thought",
      status: "final",
      speaker_label: "Judge mobile",
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:14.000Z",
      ended_at: "2026-03-12T06:48:20.000Z",
      emitted_at: "2026-03-12T06:48:20.100Z",
    },
    {
      speech_segment_id: "seg-2",
      event_id: 3,
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

function buildAttendeeEvents(): EventRecord<ZoomAttendeePresencePayload>[] {
  return [
    {
      event_id: 10,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 10,
      source: "zoom_dom",
      kind: "zoom.attendee.joined",
      ts: "2026-03-12T06:48:05.000Z",
      payload: {
        attendee_id: "zoom_user:456",
        user_id: 456,
        display_name: "Josh Mandel",
        is_host: true,
        is_co_host: false,
        is_guest: false,
        muted: false,
        video_on: true,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: true,
        details: null,
      },
    },
    {
      event_id: 11,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 11,
      source: "zoom_dom",
      kind: "zoom.attendee.joined",
      ts: "2026-03-12T06:48:08.000Z",
      payload: {
        attendee_id: "zoom_user:16780288",
        user_id: 16780288,
        display_name: "Judge mobile",
        is_host: false,
        is_co_host: false,
        is_guest: true,
        muted: false,
        video_on: false,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: true,
        details: null,
      },
    },
    {
      event_id: 12,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 12,
      source: "zoom_dom",
      kind: "zoom.attendee.left",
      ts: "2026-03-12T06:48:37.000Z",
      payload: {
        attendee_id: "zoom_user:16780288",
        user_id: 16780288,
        display_name: "Judge mobile",
        is_host: false,
        is_co_host: false,
        is_guest: true,
        muted: false,
        video_on: false,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: false,
        details: null,
      },
    },
    {
      event_id: 13,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 13,
      source: "zoom_dom",
      kind: "zoom.attendee.joined",
      ts: "2026-03-12T06:48:48.000Z",
      payload: {
        attendee_id: "zoom_user:16789504",
        user_id: 16789504,
        display_name: "Judge mobile",
        is_host: false,
        is_co_host: false,
        is_guest: true,
        muted: false,
        video_on: false,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: false,
        details: null,
      },
    },
  ];
}

function buildRescueMeetingRun(): MeetingRunRecord {
  return {
    ...buildMeetingRun(),
    state: "joining",
    worker: {
      worker_id: "worker-1",
      pid: 1234,
      ingest_port: 43111,
      cdp_port: 43112,
      status: "online",
      last_heartbeat_at: "2026-03-12T06:48:40.000Z",
    },
    updated_at: "2026-03-12T06:48:40.000Z",
  };
}

function buildRescueEvents(): EventRecord[] {
  return [
    {
      event_id: 20,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 20,
      source: "browser",
      kind: "browser.capture.bootstrap_ready",
      ts: "2026-03-12T06:48:03.000Z",
      payload: {
        bootstrap_url: "http://127.0.0.1:43111/internal/browser/bootstrap.js?token=test",
      },
    },
    {
      event_id: 21,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 21,
      source: "browser",
      kind: "browser.page.loaded",
      ts: "2026-03-12T06:48:08.000Z",
      payload: {
        page_url: "https://app.zoom.us/wc/2193058682/join",
        user_agent: "test-agent",
      },
    },
    {
      event_id: 22,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 22,
      source: "browser",
      kind: "browser.console",
      ts: "2026-03-12T06:48:30.000Z",
      payload: {
        level: "info",
        text: "join screen still visible",
      },
    },
    {
      event_id: 23,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 23,
      source: "worker",
      kind: "error.raised",
      ts: "2026-03-12T06:48:31.000Z",
      payload: {
        code: "join_stall",
        message: "Join flow appears stalled",
        fatal: false,
      },
    },
  ];
}

test("renderMarkdownTranscript defaults to speech, joins, and chat", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeech(), buildChat(), buildAttendeeEvents());

  expect(markdown).toContain("## Transcript");
  expect(markdown).toContain("Meeting start: 2026-03-12T06:48:00.000Z");
  expect(markdown).toContain("[00:10 spk=\"Judge mobile\"] Opening remarks");
  expect(markdown).toContain("[00:05 present] Josh Mandel, Judge mobile");
  expect(markdown).toContain("[00:20 chat id=1 replies=1 from=\"Judge mobile\" to=Everyone] Ahoy");
  expect(markdown).toContain("Reply text");
  expect(markdown).not.toContain("joined the meeting");
  expect(markdown).not.toContain("[cursor=");
});

test("renderMarkdownTranscript can limit output with include filters", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeech(), buildChat(), buildAttendeeEvents(), {
    include: ["speech", "chat"],
  });

  expect(markdown).toContain("[00:20 chat id=1 replies=1 from=\"Judge mobile\" to=Everyone] Ahoy");
  expect(markdown).toContain("[00:21 chat id=2 reply-to=1 from=\"Josh Mandel\" to=Everyone] Reply text");
  expect(markdown).toContain("Reply text");
  expect(markdown).not.toContain("[joins]");
  expect(markdown).not.toContain("[present]");
  expect(markdown.indexOf("Opening remarks")).toBeLessThan(markdown.indexOf("Ahoy"));
  expect(markdown.indexOf("Reply text")).toBeLessThan(markdown.indexOf("Follow up"));
});

test("renderMarkdownTranscript supports since with visible line timestamps and complete turns", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeechWithGrowingTurn(), buildChat(), buildAttendeeEvents(), {
    include: ["speech", "joins", "chat"],
    since_unix_ms: Date.parse("2026-03-12T06:48:10.000Z"),
  });

  expect(markdown).not.toContain("# 2193058682");
  expect(markdown).not.toContain("Meeting start:");
  expect(markdown).not.toContain("## Transcript");
  expect(markdown).not.toContain("[present] Josh Mandel");
  expect(markdown).toContain("[00:10 spk=\"Judge mobile\"] Opening remarks continued thought");
  expect(markdown).toContain("Reply text");
  expect(markdown).toContain("Follow up");
  expect(markdown).toContain("[00:30 spk=\"Josh Mandel\"] Follow up");
  expect(markdown).not.toContain("[cursor=");
});

test("renderMarkdownTranscript coalesces continuous unknown-speaker segments", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const speech: SpeechSegmentRecord[] = [
    {
      speech_segment_id: "seg-unknown-1",
      event_id: 1,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-unknown-1",
      text: "Let us go then.",
      status: "final",
      speaker_label: null,
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:34.000Z",
      ended_at: "2026-03-12T06:48:35.000Z",
      emitted_at: "2026-03-12T06:48:35.100Z",
    },
    {
      speech_segment_id: "seg-unknown-2",
      event_id: 2,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-unknown-2",
      text: "You and I.",
      status: "final",
      speaker_label: null,
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:36.000Z",
      ended_at: "2026-03-12T06:48:37.000Z",
      emitted_at: "2026-03-12T06:48:37.100Z",
    },
    {
      speech_segment_id: "seg-unknown-3",
      event_id: 3,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      provider: "mistral",
      provider_segment_id: "provider-seg-unknown-3",
      text: "Good evening is spread out again.",
      status: "final",
      speaker_label: null,
      speaker_confidence: null,
      started_at: "2026-03-12T06:48:38.000Z",
      ended_at: "2026-03-12T06:48:39.000Z",
      emitted_at: "2026-03-12T06:48:39.100Z",
    },
  ];

  const markdown = renderMarkdownTranscript(buildMeetingRun(), speech, [], []);

  expect(markdown).toContain("[00:34 spk=\"Unknown speaker\"] Let us go then. You and I. Good evening is spread out again.");
});

test("renderMarkdownTranscript de-duplicates grouped presence names", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const attendeeEvents: EventRecord<ZoomAttendeePresencePayload>[] = [
    {
      event_id: 10,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 10,
      source: "zoom_dom",
      kind: "zoom.attendee.joined",
      ts: "2026-03-12T06:48:05.000Z",
      payload: {
        attendee_id: "zoom_user:1",
        user_id: 1,
        display_name: "Meeting Bot",
        is_host: false,
        is_co_host: false,
        is_guest: false,
        muted: false,
        video_on: true,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: true,
        details: null,
      },
    },
    {
      event_id: 11,
      meeting_run_id: "meeting-run-test",
      room_id: "zoom:2193058682",
      seq: 11,
      source: "zoom_dom",
      kind: "zoom.attendee.joined",
      ts: "2026-03-12T06:48:08.000Z",
      payload: {
        attendee_id: "zoom_user:2",
        user_id: 2,
        display_name: "Meeting Bot",
        is_host: false,
        is_co_host: false,
        is_guest: false,
        muted: false,
        video_on: true,
        audio_connection: "computer",
        last_spoken_at_unix_ms: null,
        backfilled: true,
        details: null,
      },
    },
  ];

  const markdown = renderMarkdownTranscript(buildMeetingRun(), buildSpeech(), [], attendeeEvents);

  expect(markdown).toContain("[00:05 present] Meeting Bot");
  expect(markdown).not.toContain("Meeting Bot, Meeting Bot");
});

test("renderMarkdownTranscript never emits a cursor footer", () => {
  const app = new CoordinatorApp(buildConfig());
  const renderMarkdownTranscript = (app as any).renderMarkdownTranscript.bind(app) as (
    meetingRun: MeetingRunRecord,
    speech: SpeechSegmentRecord[],
    chat?: ChatMessageRecord[],
    attendeeEvents?: EventRecord<ZoomAttendeePresencePayload>[],
    options?: {
      include?: Array<"speech" | "joins" | "chat">;
      since_unix_ms?: number | null;
    },
  ) => string;

  const markdown = renderMarkdownTranscript({
    ...buildMeetingRun(),
    state: "completed",
    ended_at: "2026-03-12T06:49:00.000Z",
  }, buildSpeech(), buildChat(), buildAttendeeEvents());

  expect(markdown).not.toContain("[cursor=");
});

test("buildAttendeeSummaries merges guest rejoins into one attendee entry", () => {
  const app = new CoordinatorApp(buildConfig());
  const buildAttendeeSummaries = (app as any).buildAttendeeSummaries.bind(app) as (
    meetingRun: MeetingRunRecord,
    attendeeEvents: EventRecord<ZoomAttendeePresencePayload>[],
  ) => AttendeeSummaryRecord[];

  const attendees = buildAttendeeSummaries(buildMeetingRun(), buildAttendeeEvents());

  expect(attendees).toHaveLength(2);
  expect(attendees[0]?.display_name).toBe("Josh Mandel");
  expect(attendees[0]?.is_host).toBe(true);
  const judge = attendees.find((item) => item.display_name === "Judge mobile");
  expect(judge?.join_count).toBe(2);
  expect(judge?.leave_count).toBe(1);
  expect(judge?.is_guest).toBe(true);
  expect(judge?.present).toBe(true);
  expect(judge?.user_ids).toEqual([16780288, 16789504]);
});

test("renderMarkdownAttendees emits a readable attendee list", () => {
  const app = new CoordinatorApp(buildConfig());
  const buildAttendeeSummaries = (app as any).buildAttendeeSummaries.bind(app) as (
    meetingRun: MeetingRunRecord,
    attendeeEvents: EventRecord<ZoomAttendeePresencePayload>[],
  ) => AttendeeSummaryRecord[];
  const renderMarkdownAttendees = (app as any).renderMarkdownAttendees.bind(app) as (
    meetingRun: MeetingRunRecord,
    attendees: AttendeeSummaryRecord[],
  ) => string;

  const markdown = renderMarkdownAttendees(buildMeetingRun(), buildAttendeeSummaries(buildMeetingRun(), buildAttendeeEvents()));

  expect(markdown).toContain("## Attendees");
  expect(markdown).toContain("- Josh Mandel [host]");
  expect(markdown).toContain("- Judge mobile [guest, joins=2]");
  expect(markdown).not.toContain("zoom_user:16780288");
});

test("buildRescueStatus reports live rescue metadata and bootstrap url", () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  app.storage = {
    listEventRecords: () => buildRescueEvents(),
  };
  app.rescueClaimsByMeetingRunId = new Map([
    ["meeting-run-test", {
      claimed: true,
      operator: "codex",
      reason: "join_flow_stalled",
      note: "manual inspection",
      claimed_at_unix_ms: Date.parse("2026-03-12T06:48:45.000Z"),
      released_at_unix_ms: null,
    }],
  ]);

  const rescue = app.buildRescueStatus(buildRescueMeetingRun(), "http://127.0.0.1:3100");

  expect(rescue.claimed).toBe(true);
  expect(rescue.operator).toBe("codex");
  expect(rescue.worker_online).toBe(true);
  expect(rescue.cdp_port).toBe(43112);
  expect(rescue.suggested_reason).toBe("join_flow_stalled");
  expect(rescue.checkpoints.page_loaded).toBe(true);
  expect(rescue.checkpoints.capture_started).toBe(false);
  expect(rescue.latest_page_url).toBe("https://app.zoom.us/wc/2193058682/join");
  expect(rescue.latest_browser_console).toBe("join screen still visible");
  expect(rescue.browser_bootstrap_url).toContain("bootstrap.js?token=test");
  expect(rescue.screenshot_url).toBe("http://127.0.0.1:3100/v1/meeting-runs/meeting-run-test/screenshot");
  expect(rescue.recent_errors[0]?.code).toBe("join_stall");
});

test("resolveMeetingRunForRoom prefers an active run over older history", () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  app.storage = {
    listMeetingRunRecords: () => [
      {
        ...buildMeetingRun(),
        meeting_run_id: "run-completed",
        state: "completed",
        created_at: "2026-03-12T06:49:00.000Z",
      },
      {
        ...buildMeetingRun(),
        meeting_run_id: "run-capturing",
        state: "capturing",
        created_at: "2026-03-12T06:48:00.000Z",
      },
    ],
  };

  const resolved = app.resolveMeetingRunForRoom("zoom:2193058682");

  expect(resolved?.meeting_run_id).toBe("run-capturing");
});

test("handleZoomMeetingTranscript combines resumed runs for the same Zoom meeting", async () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  app.storage = {
    listMeetingRunRecords: () => [
      buildMeetingRun({
        meeting_run_id: "run-1",
        state: "completed",
        started_at: "2026-03-12T06:48:00.000Z",
        ended_at: "2026-03-12T06:50:00.000Z",
        created_at: "2026-03-12T06:48:00.000Z",
      }),
      buildMeetingRun({
        meeting_run_id: "run-2",
        tags: ["meter:resume-root:run-1", "meter:resumed-from:run-1"],
        state: "capturing",
        started_at: "2026-03-12T06:50:10.000Z",
        ended_at: null,
        created_at: "2026-03-12T06:50:10.000Z",
        updated_at: "2026-03-12T06:50:20.000Z",
      }),
    ],
    listEventRecords: ({ kind }: { kind: string }) => {
      if (kind === "transcription.segment.final") {
        return [
          {
            event_id: 1,
            meeting_run_id: "run-1",
            room_id: "zoom:2193058682",
            seq: 1,
            source: "transcription",
            kind,
            ts: "2026-03-12T06:48:12.100Z",
            payload: {
              speech_segment_id: "seg-1",
              provider: "mistral",
              provider_segment_id: "provider-seg-1",
              text: "Opening remarks",
              status: "final",
              speaker_label: "Judge mobile",
              started_at_unix_ms: Date.parse("2026-03-12T06:48:10.000Z"),
              ended_at_unix_ms: Date.parse("2026-03-12T06:48:12.000Z"),
            },
          },
          {
            event_id: 2,
            meeting_run_id: "run-2",
            room_id: "zoom:2193058682",
            seq: 1,
            source: "transcription",
            kind,
            ts: "2026-03-12T06:50:15.100Z",
            payload: {
              speech_segment_id: "seg-2",
              provider: "mistral",
              provider_segment_id: "provider-seg-2",
              text: "Resumed discussion",
              status: "final",
              speaker_label: "Josh Mandel",
              started_at_unix_ms: Date.parse("2026-03-12T06:50:14.000Z"),
              ended_at_unix_ms: Date.parse("2026-03-12T06:50:15.000Z"),
            },
          },
        ];
      }
      return [];
    },
  };

  const response = app.handleZoomMeetingTranscript(new URL("http://127.0.0.1:3100/v1/zoom-meetings/2193058682/transcript.md"), "2193058682");
  expect(response.status).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain("Opening remarks");
  expect(markdown).toContain("Resumed discussion");
});

test("patchMeetingRunFromEvents marks a run stopping when Zoom reports the meeting left", () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  const patches: Array<{ meetingRunId: string; patch: Record<string, unknown> }> = [];
  app.storage = {
    patchMeetingRun: (meetingRunId: string, patch: Record<string, unknown>) => {
      patches.push({ meetingRunId, patch });
    },
  };
  app.getMeetingRun = () => buildMeetingRun();

  app.patchMeetingRunFromEvents("meeting-run-test", [{
    event_id: 1,
    meeting_run_id: "meeting-run-test",
    room_id: "zoom:2193058682",
    seq: 1,
    source: "zoom_dom",
    kind: "zoom.meeting.left",
    ts: "2026-03-12T06:49:00.000Z",
    ts_unix_ms: Date.parse("2026-03-12T06:49:00.000Z"),
    payload: {
      reason: "ended",
    },
  }]);

  expect(patches).toHaveLength(1);
  expect(patches[0]?.meetingRunId).toBe("meeting-run-test");
  expect(patches[0]?.patch.state).toBe("stopping");
});

test("handleResumeMeetingRun creates a successor run and seeds resumed minutes", async () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  const tempDir = mkdtempSync(path.join("/tmp", "meter-resume-test-"));
  const originalNow = Date.now;
  const sourceRun = buildMeetingRun({
    meeting_run_id: "run-completed",
    state: "completed",
    ended_at: "2026-03-12T06:50:00.000Z",
  });
  const resumedRun = buildMeetingRun({
    meeting_run_id: "run-resumed",
    state: "pending",
    created_at: "2026-03-12T06:51:00.000Z",
    updated_at: "2026-03-12T06:51:00.000Z",
  });
  const spawnedMinutes: Array<{ meetingRunId: string; seed: { seed_minutes_markdown?: string | null } | null }> = [];

  app.getMeetingRun = (meetingRunId: string) => (meetingRunId === "run-completed" ? sourceRun : resumedRun);
  app.initializeMeetingRun = async () => ({
    meeting_run_id: "run-resumed",
    layout: await createMeetingRunLayout(tempDir, "run-resumed", Date.parse("2026-03-12T06:51:00.000Z"), false),
  });
  app.spawnWorker = async () => undefined;
  app.spawnMinuteJob = async (
    meetingRun: MeetingRunRecord,
    _promptConfig: unknown,
    _restartedFrom: string | null,
    seed: { seed_minutes_markdown?: string | null } | null,
  ) => {
    spawnedMinutes.push({ meetingRunId: meetingRun.meeting_run_id, seed });
    return {
      minute_job_id: "minute-job-resumed",
      meeting_run_id: meetingRun.meeting_run_id,
    };
  };
  app.getLatestMinuteJob = (meetingRunId: string) => (
    meetingRunId === "run-completed"
      ? {
          minute_job_id: "minute-job-source",
          meeting_run_id: "run-completed",
          room_id: "zoom:2193058682",
          state: "completed",
          provider: "openrouter_patch",
          tmux_session_name: null,
          command: null,
          prompt_template_id: "default",
          prompt_label: "Default",
          prompt_hash: null,
          user_prompt_body: "Keep concise minutes",
          claude_model: null,
          claude_effort: null,
          openrouter_model: "openai/gpt-4.1-mini",
          working_dir: "/tmp/meter-test",
          latest_minutes_path: "/tmp/meter-test/minutes.md",
          latest_content_sha256: null,
          latest_version_seq: 1,
          started_at: "2026-03-12T06:48:00.000Z",
          ended_at: "2026-03-12T06:50:00.000Z",
          last_update_at: "2026-03-12T06:50:00.000Z",
          restarted_from_minute_job_id: null,
          last_error: null,
        }
      : null
  );
  app.storage = {
    getMeetingRunRecord: (meetingRunId: string) => (meetingRunId === "run-resumed" ? resumedRun : sourceRun),
    getLatestMinuteVersionForMinuteJob: () => ({
      minute_version_id: "minute-version-source",
      minute_job_id: "minute-job-source",
      meeting_run_id: "run-completed",
      room_id: "zoom:2193058682",
      seq: 1,
      status: "final",
      content_markdown: "# Minutes\n\nExisting notes",
      content_sha256: "sha",
      created_at: "2026-03-12T06:50:00.000Z",
    }),
    listMeetingRunRecords: () => [resumedRun, sourceRun],
  };

  try {
    Date.now = () => Date.parse("2026-03-12T06:51:00.000Z");
    const response = await app.handleResumeMeetingRun(
      new Request("http://127.0.0.1:3100/v1/meeting-runs/run-completed/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      "run-completed",
    );
    expect(response.status).toBe(201);
    expect(spawnedMinutes).toEqual([
      {
        meetingRunId: "run-resumed",
        seed: {
          seed_minutes_markdown: "# Minutes\n\nExisting notes",
        },
      },
    ]);
  } finally {
    Date.now = originalNow;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("renderAutomatedRescuePrompt injects meeting context into the prompt", async () => {
  const originalCommand = process.env.METER_AUTOMATED_RESCUE_COMMAND;
  const originalOperator = process.env.METER_AUTOMATED_RESCUE_OPERATOR;
  process.env.METER_AUTOMATED_RESCUE_COMMAND = "codex exec --yolo";
  process.env.METER_AUTOMATED_RESCUE_OPERATOR = "codex-auto";
  try {
    const app = new CoordinatorApp(buildConfig()) as any;
    app.storage = {
      listEventRecords: () => buildRescueEvents(),
    };

    const meetingRun = buildRescueMeetingRun();
    const rescue = app.buildRescueStatus(meetingRun, "http://127.0.0.1:3100");
    const prompt = await app.renderAutomatedRescuePrompt(meetingRun, rescue, {
      rescue_artifacts: {
        prompt_path: "/tmp/prompt.md",
        context_path: "/tmp/context.json",
        log_path: "/tmp/attempt.log",
      },
    });

    expect(prompt).toContain("Meeting run ID: `meeting-run-test`");
    expect(prompt).toContain("Operator name: `codex-auto`");
    expect(prompt).toContain("Suggested reason: join_flow_stalled");
    expect(prompt).toContain("\"suggested_reason\": \"join_flow_stalled\"");
    expect(prompt).toContain("\"prompt_path\": \"/tmp/prompt.md\"");
  } finally {
    if (originalCommand === undefined) {
      delete process.env.METER_AUTOMATED_RESCUE_COMMAND;
    } else {
      process.env.METER_AUTOMATED_RESCUE_COMMAND = originalCommand;
    }
    if (originalOperator === undefined) {
      delete process.env.METER_AUTOMATED_RESCUE_OPERATOR;
    } else {
      process.env.METER_AUTOMATED_RESCUE_OPERATOR = originalOperator;
    }
  }
});

test("launchAutomatedRescue streams a self-contained prompt over stdin", async () => {
  const originalCommand = process.env.METER_AUTOMATED_RESCUE_COMMAND;
  const originalOperator = process.env.METER_AUTOMATED_RESCUE_OPERATOR;
  const tempDir = mkdtempSync(path.join("/tmp", "meter-auto-rescue-test-"));
  const stdinPath = path.join(tempDir, "stdin.txt");
  process.env.METER_AUTOMATED_RESCUE_COMMAND = `cat > '${stdinPath}'`;
  process.env.METER_AUTOMATED_RESCUE_OPERATOR = "codex-auto";

  try {
    const app = new CoordinatorApp(buildConfig()) as any;
    app.storage = {
      listEventRecords: () => buildRescueEvents(),
    };
    app.coordinatorLogPath = path.join(tempDir, "coordinator.log");

    const meetingRun = {
      ...buildRescueMeetingRun(),
      paths: {
        ...buildRescueMeetingRun().paths,
        data_dir: tempDir,
      },
    };
    const rescue = app.buildRescueStatus(meetingRun, "http://127.0.0.1:3100");

    await app.launchAutomatedRescue(meetingRun, rescue, 1);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (existsSync(stdinPath)) {
        break;
      }
      await Bun.sleep(50);
    }

    expect(existsSync(stdinPath)).toBe(true);

    const stdinText = readFileSync(stdinPath, "utf8");
    const rescueDir = path.join(tempDir, "rescue");

    expect(stdinText).toContain("Meeting run ID: `meeting-run-test`");
    expect(stdinText).toContain("Meter base URL: `http://127.0.0.1:3100`");
    expect(stdinText).toContain(`"prompt_path": "${path.join(rescueDir, "attempt-1.prompt.md")}"`);
    expect(stdinText).toContain(`"context_path": "${path.join(rescueDir, "attempt-1.context.json")}"`);
    expect(stdinText).toContain(`"log_path": "${path.join(rescueDir, "attempt-1.log")}"`);
    expect(await Bun.file(path.join(rescueDir, "attempt-1.log")).exists()).toBe(true);
    expect(await Bun.file(path.join(rescueDir, "attempt-1.context.json")).exists()).toBe(true);
  } finally {
    if (originalCommand === undefined) {
      delete process.env.METER_AUTOMATED_RESCUE_COMMAND;
    } else {
      process.env.METER_AUTOMATED_RESCUE_COMMAND = originalCommand;
    }
    if (originalOperator === undefined) {
      delete process.env.METER_AUTOMATED_RESCUE_OPERATOR;
    } else {
      process.env.METER_AUTOMATED_RESCUE_OPERATOR = originalOperator;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("minute prompt presets can be saved, listed with templates, and deleted", async () => {
  const tempDir = mkdtempSync(path.join("/tmp", "meter-minute-presets-"));
  const authEnv = captureAuthEnv();
  process.env.METER_ADMIN_PASSWORD = "swordfish";
  delete process.env.METER_ADMIN_PASSWORD_HASH;
  delete process.env.METER_VIEWER_PASSWORD;
  delete process.env.METER_VIEWER_PASSWORD_HASH;
  delete process.env.METER_REQUIRE_AUTH_FOR_READS;
  const app = new CoordinatorApp(buildTempConfig(tempDir));

  try {
    await app.start();
    const port = (app as any).server.port as number;
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "swordfish" }),
    });
    const auth = await login.json() as { csrf_token: string | null };
    const cookie = login.headers.get("set-cookie") ?? "";

    const saveResponse = await fetch(`${baseUrl}/v1/minute-prompt-presets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-meter-csrf": auth.csrf_token ?? "",
      },
      body: JSON.stringify({
        name: "FHIR WG formal",
        provider: "claude_tmux",
        prompt_template_id: "decision-journal",
        user_prompt_body: "Capture decisions and owners",
        claude_model: "sonnet",
        claude_effort: "high",
      }),
    });
    expect(saveResponse.status).toBe(201);
    const savedBody = await saveResponse.json() as { preset: { name: string; prompt_template_id: string | null; claude_effort: string | null } };
    expect(savedBody.preset.name).toBe("FHIR WG formal");
    expect(savedBody.preset.prompt_template_id).toBe("decision-journal");
    expect(savedBody.preset.claude_effort).toBe("high");

    const listResponse = await fetch(`${baseUrl}/v1/minute-prompt-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as { saved_presets?: Array<{ name: string; prompt_template_id: string | null }> };
    expect(listBody.saved_presets?.some((preset) => preset.name === "FHIR WG formal" && preset.prompt_template_id === "decision-journal")).toBe(true);

    const deleteResponse = await fetch(`${baseUrl}/v1/minute-prompt-presets/FHIR%20WG%20formal`, {
      method: "DELETE",
      headers: {
        cookie,
        "x-meter-csrf": auth.csrf_token ?? "",
      },
    });
    expect(deleteResponse.status).toBe(200);

    const listAfterDelete = await fetch(`${baseUrl}/v1/minute-prompt-templates`);
    const deletedBody = await listAfterDelete.json() as { saved_presets?: Array<{ name: string }> };
    expect(deletedBody.saved_presets?.some((preset) => preset.name === "FHIR WG formal")).toBe(false);
  } finally {
    restoreAuthEnv(authEnv);
    await app.stop().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public mutations require an authenticated admin session", async () => {
  const tempDir = mkdtempSync(path.join("/tmp", "meter-auth-session-"));
  const authEnv = captureAuthEnv();
  process.env.METER_ADMIN_PASSWORD = "swordfish";
  delete process.env.METER_ADMIN_PASSWORD_HASH;
  delete process.env.METER_VIEWER_PASSWORD;
  delete process.env.METER_VIEWER_PASSWORD_HASH;
  delete process.env.METER_REQUIRE_AUTH_FOR_READS;
  const app = new CoordinatorApp(buildTempConfig(tempDir));

  try {
    await app.start();
    const port = (app as any).server.port as number;
    const baseUrl = `http://127.0.0.1:${port}`;

    const denied = await fetch(`${baseUrl}/v1/meeting-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ join_url: "https://zoom.us/j/123456789" }),
    });
    expect(denied.status).toBe(401);

    const login = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "swordfish" }),
    });
    expect(login.status).toBe(201);
    const auth = await login.json() as { authenticated: boolean; role: string | null; csrf_token: string | null };
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe("admin");
    expect(auth.csrf_token).toBeTruthy();
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("meter_auth_session=");

    const allowed = await fetch(`${baseUrl}/v1/meeting-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
        "x-meter-csrf": auth.csrf_token ?? "",
      },
      body: JSON.stringify({ join_url: "https://zoom.us/j/123456789" }),
    });
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);
  } finally {
    restoreAuthEnv(authEnv);
    await app.stop().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public reads can require an authenticated viewer or admin session", async () => {
  const tempDir = mkdtempSync(path.join("/tmp", "meter-read-auth-"));
  const authEnv = captureAuthEnv();
  process.env.METER_ADMIN_PASSWORD = "swordfish";
  process.env.METER_VIEWER_PASSWORD = "viewonly";
  process.env.METER_REQUIRE_AUTH_FOR_READS = "true";
  delete process.env.METER_ADMIN_PASSWORD_HASH;
  delete process.env.METER_VIEWER_PASSWORD_HASH;
  const app = new CoordinatorApp(buildTempConfig(tempDir));

  try {
    await app.start();
    const port = (app as any).server.port as number;
    const baseUrl = `http://127.0.0.1:${port}`;

    const anonymousRead = await fetch(`${baseUrl}/v1/meeting-runs`);
    expect(anonymousRead.status).toBe(401);

    const viewerLogin = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "viewonly" }),
    });
    expect(viewerLogin.status).toBe(201);
    const viewerAuth = await viewerLogin.json() as { authenticated: boolean; role: string | null; read_auth_required: boolean };
    expect(viewerAuth.authenticated).toBe(true);
    expect(viewerAuth.role).toBe("viewer");
    expect(viewerAuth.read_auth_required).toBe(true);
    const viewerCookie = viewerLogin.headers.get("set-cookie") ?? "";

    const viewerRead = await fetch(`${baseUrl}/v1/meeting-runs`, {
      headers: { cookie: viewerCookie },
    });
    expect(viewerRead.status).toBe(200);

    const viewerMutation = await fetch(`${baseUrl}/v1/meeting-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({ join_url: "https://zoom.us/j/123456789" }),
    });
    expect(viewerMutation.status).toBe(401);

    const adminLogin = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "swordfish" }),
    });
    expect(adminLogin.status).toBe(201);
    const adminCookie = adminLogin.headers.get("set-cookie") ?? "";

    const adminRead = await fetch(`${baseUrl}/v1/meeting-runs`, {
      headers: { cookie: adminCookie },
    });
    expect(adminRead.status).toBe(200);
  } finally {
    restoreAuthEnv(authEnv);
    await app.stop().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handleResumeMeetingRun rejects runs outside the 2 hour resume window", async () => {
  const app = new CoordinatorApp(buildConfig()) as any;
  app.getMeetingRun = () => buildMeetingRun({
    meeting_run_id: "run-old",
    state: "completed",
    ended_at: "2026-03-12T04:00:00.000Z",
  });

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-12T06:48:00.000Z");
  try {
    const response = await app.handleResumeMeetingRun(
      new Request("http://127.0.0.1:3100/v1/meeting-runs/run-old/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      "run-old",
    );
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("meeting_run_resume_window_expired");
  } finally {
    Date.now = originalNow;
  }
});

test("minute jobs can start, stream, restart, and stop without leaking old visible state", async () => {
  const tempDir = mkdtempSync(path.join("/tmp", "meter-minute-job-"));
  const fakeMinuteTakerPath = path.join(tempDir, "fake-minute-taker.ts");
  const originalEntry = process.env.METER_MINUTE_TAKER_ENTRY;
  const originalCwd = process.env.METER_MINUTE_TAKER_CWD;
  process.env.METER_MINUTE_TAKER_ENTRY = fakeMinuteTakerPath;
  process.env.METER_MINUTE_TAKER_CWD = tempDir;

  await Bun.write(fakeMinuteTakerPath, `#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < Bun.argv.length; index += 1) {
  const key = Bun.argv[index];
  if (!key.startsWith("--")) continue;
  const next = Bun.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
    continue;
  }
  args.set(key, next);
  index += 1;
}

const meetingRunId = args.get("--meeting-run-id");
const minutesRoot = path.resolve(args.get("--minutes-root") ?? "./minutes");
const runDir = path.join(minutesRoot, meetingRunId);
const config = process.env.METER_MINUTE_TAKER_CONFIG_B64
  ? JSON.parse(Buffer.from(process.env.METER_MINUTE_TAKER_CONFIG_B64, "base64").toString("utf8"))
  : {};

mkdirSync(runDir, { recursive: true });
if (config.reset_output) {
  rmSync(path.join(runDir, "minutes.md"), { force: true });
}

const prompt = (config.user_prompt_body ?? "default").trim() || "default";
const provider = (config.provider ?? "claude_tmux").trim() || "claude_tmux";
const promptTemplateId = (config.prompt_template_id ?? "").trim();
const claudeModel = (config.claude_model ?? "").trim();
const claudeEffort = (config.claude_effort ?? "").trim();
const openrouterModel = (config.openrouter_model ?? "").trim();
const write = (label) => {
  writeFileSync(path.join(runDir, "minutes.md"), "# Minutes\\n\\nProvider: " + provider + "\\n\\nTemplate: " + promptTemplateId + "\\n\\nPrompt: " + prompt + "\\n\\nModel: " + claudeModel + "\\n\\nEffort: " + claudeEffort + "\\n\\nOpenRouter Model: " + openrouterModel + "\\n\\nState: " + label + "\\n");
};

setTimeout(() => write("running"), 50);
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  setTimeout(() => process.exit(0), 20);
});
`);

  const app = new CoordinatorApp(buildTempConfig(tempDir));
  const meetingRunId = "meeting-run-test";
  const roomId = "zoom:2193058682";

  const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for condition");
  };

  try {
    await app.start();
    const port = (app as any).server.port as number;
    const baseUrl = `http://127.0.0.1:${port}`;
    const now = Date.parse("2026-03-12T06:48:00.000Z");
    const layout = await createMeetingRunLayout(tempDir, meetingRunId, now, false);
    const storage = (app as any).storage;
    storage.upsertRoom({
      room_id: roomId,
      provider_room_key: "2193058682",
      display_name: "Zoom 2193058682",
      normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
      now_unix_ms: now,
    });
    storage.insertMeetingRun({
      meeting_run_id: meetingRunId,
      room_id: roomId,
      normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
      requested_by: null,
      bot_name: "Meeting Bot",
      state: "capturing",
      data_dir: layout.data_dir,
      created_at_unix_ms: now,
      tags: [],
      options: buildMeetingRun().options,
      paths: layout,
    });

    const startResponse = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude_tmux",
        prompt_template_id: "decision-journal",
        user_prompt_body: "Alpha minutes",
        claude_model: "claude-3-5-haiku-latest",
        claude_effort: "medium",
      }),
    });
    expect(startResponse.status).toBe(201);
    const started = await startResponse.json() as { minute_job: { minute_job_id: string } };

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes.md`);
      return response.ok && (await response.text()).includes("Alpha minutes");
    });

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes`);
      const body = await response.json() as {
        minute_job: { minute_job_id: string } | null;
        latest_version: { content_markdown: string } | null;
      };
      return body.latest_version?.content_markdown.includes("Alpha minutes") ?? false;
    });

    const currentMinutes = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes`).then((value) => value.json()) as {
      minute_job: {
        minute_job_id: string;
        provider: string;
        prompt_template_id: string | null;
        claude_model: string | null;
        claude_effort: string | null;
        latest_version_seq: number;
        last_update_at: string | null;
      } | null;
      latest_version: { content_markdown: string } | null;
    };
    expect(currentMinutes.minute_job?.minute_job_id).toBe(started.minute_job.minute_job_id);
    expect(currentMinutes.minute_job?.provider).toBe("claude_tmux");
    expect(currentMinutes.minute_job?.prompt_template_id).toBe("decision-journal");
    expect(currentMinutes.minute_job?.claude_model).toBe("claude-3-5-haiku-latest");
    expect(currentMinutes.minute_job?.claude_effort).toBe("medium");
    expect(currentMinutes.minute_job?.latest_version_seq).toBeGreaterThan(0);
    expect(currentMinutes.minute_job?.last_update_at).toBeTruthy();
    expect(currentMinutes.latest_version?.content_markdown).toContain("Alpha minutes");
    expect(currentMinutes.latest_version?.content_markdown).toContain("Provider: claude_tmux");
    expect(currentMinutes.latest_version?.content_markdown).toContain("Template: decision-journal");
    expect(currentMinutes.latest_version?.content_markdown).toContain("Model: claude-3-5-haiku-latest");
    expect(currentMinutes.latest_version?.content_markdown).toContain("Effort: medium");

    const streamResponse = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes/stream`);
    expect(streamResponse.ok).toBe(true);
    const streamReader = streamResponse.body?.getReader();
    const firstChunk = streamReader ? await streamReader.read() : null;
    const streamText = firstChunk?.value ? Buffer.from(firstChunk.value).toString("utf8") : "";
    expect(streamText).toContain("event: minutes");
    expect(streamText).toContain("Alpha minutes");
    await streamReader?.cancel();

    const viewHtml = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes/view`).then((value) => value.text());
    expect(viewHtml).toContain("minutes-view");
    expect(viewHtml).toContain('id="root"');

    const restartResponse = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter_patch",
        user_prompt_body: "Beta minutes",
        openrouter_model: "openai/gpt-4.1-mini",
      }),
    });
    expect(restartResponse.status).toBe(200);
    const restarted = await restartResponse.json() as { minute_job: { minute_job_id: string } };
    expect(restarted.minute_job.minute_job_id).not.toBe(started.minute_job.minute_job_id);

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes`);
      const body = await response.json() as {
        minute_job: {
          minute_job_id: string;
          provider: string;
          claude_model: string | null;
          claude_effort: string | null;
          openrouter_model: string | null;
        } | null;
        latest_version: { content_markdown: string } | null;
      };
      return body.minute_job?.minute_job_id === restarted.minute_job.minute_job_id
        && body.minute_job?.provider === "openrouter_patch"
        && body.minute_job?.openrouter_model === "openai/gpt-4.1-mini"
        && body.latest_version?.content_markdown.includes("Beta minutes");
    });

    const markdownAfterRestart = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes.md`).then((value) => value.text());
    expect(markdownAfterRestart).toContain("Beta minutes");
    expect(markdownAfterRestart).toContain("Provider: openrouter_patch");
    expect(markdownAfterRestart).toContain("OpenRouter Model: openai/gpt-4.1-mini");
    expect(markdownAfterRestart).not.toContain("Alpha minutes");

    const stopResponse = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(stopResponse.status).toBe(200);

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/v1/meeting-runs/${meetingRunId}/minutes`);
      const body = await response.json() as { minute_job: { state: string } | null };
      return body.minute_job?.state === "completed";
    });
  } finally {
    await app.stop();
    if (originalEntry === undefined) {
      delete process.env.METER_MINUTE_TAKER_ENTRY;
    } else {
      process.env.METER_MINUTE_TAKER_ENTRY = originalEntry;
    }
    if (originalCwd === undefined) {
      delete process.env.METER_MINUTE_TAKER_CWD;
    } else {
      process.env.METER_MINUTE_TAKER_CWD = originalCwd;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
