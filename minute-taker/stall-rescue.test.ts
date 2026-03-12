import { expect, test } from "bun:test";

import {
  STALE_MINUTES_RESCUE_COOLDOWN_MS,
  STALE_MINUTES_RESCUE_MS,
  createMinuteRescueState,
  getLargeQueueDepthThreshold,
  getUnacknowledgedChunkDepth,
  noteChunkSent,
  noteMinutesSnapshot,
  noteRescue,
  shouldRescueQueuedMinutes,
} from "./stall-rescue";

const emptySnapshot = {
  exists: false,
  content: null,
  mtimeMs: 0,
};

test("queued chunk depth is acknowledged by the next visible minutes write", () => {
  let state = createMinuteRescueState(emptySnapshot, 0);
  state = noteChunkSent(state, 3);
  state = noteChunkSent(state, 5);

  expect(getUnacknowledgedChunkDepth(state)).toBe(5);

  state = noteMinutesSnapshot(state, {
    exists: true,
    content: "# Minutes\n\nUpdated",
    mtimeMs: 10,
  }, 10);

  expect(state.lastAcknowledgedChunkIndex).toBe(5);
  expect(getUnacknowledgedChunkDepth(state)).toBe(0);
});

test("rescue only triggers after the queue is large and minutes are stale for over two minutes", () => {
  const pollIntervalMs = 15_000;
  const threshold = getLargeQueueDepthThreshold(pollIntervalMs);
  let state = createMinuteRescueState(emptySnapshot, 0);

  for (let index = 1; index <= threshold; index++) {
    state = noteChunkSent(state, index);
  }

  expect(shouldRescueQueuedMinutes(state, STALE_MINUTES_RESCUE_MS, pollIntervalMs)).toBe(false);
  expect(shouldRescueQueuedMinutes(state, STALE_MINUTES_RESCUE_MS + 1, pollIntervalMs)).toBe(true);
});

test("rescue does not trigger for small backlogs even when minutes are stale", () => {
  const pollIntervalMs = 15_000;
  const threshold = getLargeQueueDepthThreshold(pollIntervalMs);
  let state = createMinuteRescueState(emptySnapshot, 0);

  for (let index = 1; index < threshold; index++) {
    state = noteChunkSent(state, index);
  }

  expect(shouldRescueQueuedMinutes(state, STALE_MINUTES_RESCUE_MS + 5_000, pollIntervalMs)).toBe(false);
});

test("rescue honors cooldown until either progress resumes or the cooldown expires", () => {
  const pollIntervalMs = 15_000;
  const threshold = getLargeQueueDepthThreshold(pollIntervalMs);
  let state = createMinuteRescueState(emptySnapshot, 0);

  for (let index = 1; index <= threshold + 2; index++) {
    state = noteChunkSent(state, index);
  }

  state = noteRescue(state, STALE_MINUTES_RESCUE_MS + 1);

  expect(
    shouldRescueQueuedMinutes(state, STALE_MINUTES_RESCUE_MS + STALE_MINUTES_RESCUE_COOLDOWN_MS, pollIntervalMs),
  ).toBe(false);
  expect(
    shouldRescueQueuedMinutes(state, STALE_MINUTES_RESCUE_MS + STALE_MINUTES_RESCUE_COOLDOWN_MS + 2, pollIntervalMs),
  ).toBe(true);
});
