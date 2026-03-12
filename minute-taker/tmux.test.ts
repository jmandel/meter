import { expect, test } from "bun:test";

import { buildClaudeLaunchCommand } from "./tmux";

test("buildClaudeLaunchCommand includes optional model and effort flags", () => {
  const command = buildClaudeLaunchCommand("/tmp/system-prompt.txt", {
    model: "sonnet",
    effort: "medium",
  });

  expect(command).toContain('claude --dangerously-skip-permissions');
  expect(command).toContain('--model "sonnet"');
  expect(command).toContain("--effort medium");
  expect(command).toContain(`--append-system-prompt "$(cat '/tmp/system-prompt.txt')"`);
});

test("buildClaudeLaunchCommand omits unset model and effort", () => {
  const command = buildClaudeLaunchCommand("/tmp/system-prompt.txt");

  expect(command).not.toContain("--model");
  expect(command).not.toContain("--effort");
});
