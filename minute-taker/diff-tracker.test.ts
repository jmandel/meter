import { expect, test } from "bun:test";

import { createTracker, processResponse } from "./diff-tracker";

test("processResponse ignores an identical replay", () => {
  const tracker = createTracker();
  const chunk = "[00:10 spk=\"Lloyd\"] Opening remarks";

  const first = processResponse(tracker, chunk);
  const second = processResponse(tracker, chunk);

  expect(first).not.toBeNull();
  expect(second).toBeNull();
  expect(tracker.cursor).toBe("00:10");
});

test("processResponse still emits a growing repeated turn", () => {
  const tracker = createTracker();
  const firstChunk = "[00:10 spk=\"Lloyd\"] Opening remarks";
  const secondChunk = "[00:10 spk=\"Lloyd\"] Opening remarks continued thought\n[00:24 chat id=1 from=\"Gino\" to=Everyone] Link";

  const first = processResponse(tracker, firstChunk);
  const second = processResponse(tracker, secondChunk);

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second?.content).toContain("continued thought");
  expect(second?.content).toContain("[00:24 chat");
  expect(tracker.cursor).toBe("00:24");
});
