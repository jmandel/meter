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
