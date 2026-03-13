import { expect, test } from "bun:test";

import { normalizeZoomJoinUrl } from "./zoom";

test("normalizeZoomJoinUrl accepts a plain meeting number", () => {
  expect(normalizeZoomJoinUrl("2193058682")).toEqual({
    room_id: "zoom:2193058682",
    provider_room_key: "2193058682",
    normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
  });
});

test("normalizeZoomJoinUrl accepts a spaced or hyphenated meeting number", () => {
  expect(normalizeZoomJoinUrl("219 305 8682")).toEqual({
    room_id: "zoom:2193058682",
    provider_room_key: "2193058682",
    normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
  });
  expect(normalizeZoomJoinUrl("219-305-8682")).toEqual({
    room_id: "zoom:2193058682",
    provider_room_key: "2193058682",
    normalized_join_url: "https://app.zoom.us/wc/join/2193058682",
  });
});

test("normalizeZoomJoinUrl preserves password-bearing zoom URLs", () => {
  expect(normalizeZoomJoinUrl("https://us05web.zoom.us/j/2193058682?pwd=PNM1igEYyrZOhlqJ6gV3kFd2jSlLNW")).toEqual({
    room_id: "zoom:2193058682",
    provider_room_key: "2193058682",
    normalized_join_url: "https://app.zoom.us/wc/join/2193058682?pwd=PNM1igEYyrZOhlqJ6gV3kFd2jSlLNW",
  });
});
