import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TmuxSession {
  sessionName: string;
  workingDir: string;
}

interface ClaudeLaunchOptions {
  model?: string | null;
  effort?: "low" | "medium" | "high" | "max" | null;
}

async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim() };
}

export async function sessionExists(sessionName: string): Promise<boolean> {
  const { exitCode } = await run(["has-session", "-t", sessionName]);
  return exitCode === 0;
}

export async function createSession(
  sessionName: string,
  workingDir: string,
): Promise<TmuxSession> {
  if (await sessionExists(sessionName)) {
    console.log(`Killing existing tmux session "${sessionName}"`);
    await run(["kill-session", "-t", sessionName]);
  }
  const { exitCode } = await run([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    workingDir,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failed to create tmux session "${sessionName}"`);
  }
  return { sessionName, workingDir };
}

export async function killSession(session: TmuxSession): Promise<void> {
  await run(["kill-session", "-t", session.sessionName]);
}

export function buildClaudeLaunchCommand(promptPath: string, options: ClaudeLaunchOptions = {}): string {
  const args = [
    "claude",
    "--dangerously-skip-permissions",
    "--tools",
    `"Read,Write,Glob"`,
  ];
  if (options.model?.trim()) {
    args.push("--model", `"${options.model.trim().replace(/"/g, '\\"')}"`);
  }
  if (options.effort?.trim()) {
    args.push("--effort", options.effort.trim());
  }
  args.push("--append-system-prompt", `"$(cat '${promptPath}')"`);
  return args.join(" ");
}

export async function launchClaude(
  session: TmuxSession,
  systemPrompt: string,
  options: ClaudeLaunchOptions = {},
): Promise<void> {
  const promptPath = `${session.workingDir}/.system-prompt.txt`;
  await Bun.write(promptPath, systemPrompt);

  const launcherPath = `${session.workingDir}/.launch-claude.sh`;
  await Bun.write(
    launcherPath,
    `#!/bin/bash\nexec ${buildClaudeLaunchCommand(promptPath, options)}\n`,
  );
  const { exitCode } = await run([
    "send-keys",
    "-t",
    session.sessionName,
    `bash ${launcherPath}`,
    "Enter",
  ]);
  if (exitCode !== 0) {
    throw new Error("Failed to send launch command to tmux");
  }
}

/**
 * Paste multi-line text into the tmux session using load-buffer + paste-buffer.
 * The text is written to a temp file, loaded into a tmux buffer, then pasted
 * into the target pane. Finishes with Enter to submit.
 */
export async function pasteMessage(
  session: TmuxSession,
  text: string,
): Promise<void> {
  const bufferFile = join(tmpdir(), `mt-paste-${process.pid}.txt`);
  await Bun.write(bufferFile, text);

  await run(["load-buffer", bufferFile]);
  await run(["paste-buffer", "-t", session.sessionName]);
  // Brief delay for Claude Code to process the bracketed paste
  await new Promise((r) => setTimeout(r, 200));
  // Send Enter outside the bracketed paste to actually submit
  await run(["send-keys", "-t", session.sessionName, "Enter"]);
}

/**
 * Send a short single-line message via send-keys (for simple commands).
 */
export async function sendMessage(
  session: TmuxSession,
  message: string,
): Promise<void> {
  const escaped = message.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  await run(["send-keys", "-t", session.sessionName, escaped, "Enter"]);
}
