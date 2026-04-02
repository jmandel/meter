import { expect, test } from "bun:test";

import { renderBootstrapScript } from "./bootstrap";

test("renderBootstrapScript prefers main-tile speaker selectors before legacy active-speaker wrappers", () => {
  const script = renderBootstrapScript({
    browser_token: "token",
    meeting_run_id: "meeting-run-id",
    room_id: "zoom:2193058682",
    worker_base_url: "http://127.0.0.1:3100",
    open_chat_panel: true,
  });

  const mainViewIndex = script.indexOf(".single-main-container__main-view");
  const footerIndex = script.indexOf(".video-avatar__avatar-footer");
  const legacyIndex = script.indexOf(".speaker-active-container__wrap");

  expect(mainViewIndex).toBeGreaterThan(-1);
  expect(footerIndex).toBeGreaterThan(-1);
  expect(legacyIndex).toBeGreaterThan(-1);
  expect(mainViewIndex).toBeLessThan(legacyIndex);
});

test("renderBootstrapScript includes store-backed speaker fallbacks and suspended-tile selectors", () => {
  const script = renderBootstrapScript({
    browser_token: "token",
    meeting_run_id: "meeting-run-id",
    room_id: "zoom:2193058682",
    worker_base_url: "http://127.0.0.1:3100",
    open_chat_panel: true,
  });

  expect(script).toContain("currentSpeakerActiveVideo");
  expect(script).toContain("currentMultiSpeakerActiveVideo");
  expect(script).toContain("activeSpeakerList");
  expect(script).toContain("currentRenderVideo");
  expect(script).toContain("currentSuspensionAllVideos");
  expect(script).toContain("firstVisibleMatchingElement");
  expect(script).toContain(".single-suspension-container__video-frame");
  expect(script).toContain(".suspension-window-container .video-avatar__avatar");
  expect(script).toContain("getSpeakerCandidateFromStore() || getSpeakerCandidateFromDom()");
});

test("renderBootstrapScript includes explicit meeting-exit detection fallbacks", () => {
  const script = renderBootstrapScript({
    browser_token: "token",
    meeting_run_id: "meeting-run-id",
    room_id: "zoom:2193058682",
    worker_base_url: "http://127.0.0.1:3100",
    open_chat_panel: true,
  });

  expect(script).toContain("zoom.meeting.left");
  expect(script).toContain("this meeting has ended");
  expect(script).toContain("removed you from the meeting");
  expect(script).toContain("post-meeting-shell");
  expect(script).toContain("audio-track-ended");
  expect(script).toContain("hasVisibleInMeetingLeaveButton");
  expect(script).toContain("hasVisibleMeetingApp");
  expect(script).toContain("storeLooksLive");
  expect(script).toContain("meetingExitCandidateCount >= 2");
});
