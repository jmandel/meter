import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";

import { CoordinatorApp } from "./coordinator";
import type { InternalConfig, StartSimulationResponse } from "./domain";
import { parseSimulationDurationMs, parseSimulationScript } from "./simulation";

function buildConfig(tempDir: string): InternalConfig {
  return {
    mode: "all",
    public_base_url: "",
    listen_host: "127.0.0.1",
    listen_port: 0,
    data_root: tempDir,
    chrome_bin: "chromium",
    default_bot_name: "Meeting Bot",
    transcription_provider: "none",
    persist_live_pcm: false,
    persist_archive_audio: true,
    archive_chunk_ms: 5000,
    live_pcm_chunk_ms: 480,
    sqlite_path: path.join(tempDir, "index.sqlite"),
    coordinator_base_url: "http://127.0.0.1:0",
    coordinator_token: "test-token",
    heartbeat_interval_ms: 5000,
  };
}

test("parseSimulationScript parses directives and timed steps", () => {
  const scenario = parseSimulationScript([
    "meeting 2193058682",
    "title \"Weekly Sync Simulation\"",
    "speed 2",
    "+0.5s attendee.join id=host-1 name=\"Alice Host\" host=1",
    "+1s say speaker=\"Alice Host\" text=\"Hello team\"",
    "+2s end state=completed",
  ].join("\n"));

  expect(scenario.meeting_id).toBe("2193058682");
  expect(scenario.title).toBe("Weekly Sync Simulation");
  expect(scenario.speed).toBe(2);
  expect(scenario.steps).toHaveLength(3);
  expect(scenario.steps[0]?.delay_ms).toBe(parseSimulationDurationMs("0.5s"));
  expect(scenario.steps[1]?.action).toBe("say");
  expect(scenario.steps[1]?.args.text).toBe("Hello team");
});

test("simulation API replays scripted meeting events into transcript and attendees surfaces", async () => {
  const tempDir = mkdtempSync(path.join("/tmp", "meter-sim-"));
  const app = new CoordinatorApp(buildConfig(tempDir));

  try {
    await app.start();
    const port = (app as any).server.port as number;
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/v1/simulations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        speed: 50,
        script: [
          "meeting 5551234567",
          "title \"Simulation Demo\"",
          "+0s attendee.join id=host-1 user_id=101 name=\"Alice Host\" host=1",
          "+0.2s say speaker=\"Alice Host\" text=\"Hello team\"",
          "+0.2s chat from=\"Alice Host\" to=\"Everyone\" text=\"Please review the notes\"",
          "+0.2s end",
        ].join("\n"),
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as StartSimulationResponse;

    await Bun.sleep(150);

    const transcript = await fetch(body.simulation.transcript_url).then((value) => value.text());
    expect(transcript).toContain("Hello team");
    expect(transcript).toContain("cursor ");

    const attendees = await fetch(body.simulation.attendees_url).then((value) => value.json()) as { items: Array<{ display_name: string | null }> };
    expect(attendees.items[0]?.display_name).toBe("Alice Host");

    const streamResponse = await fetch(body.simulation.stream_url);
    expect(streamResponse.ok).toBe(true);
    const reader = streamResponse.body?.getReader();
    const firstChunk = reader ? await reader.read() : null;
    const chunkText = firstChunk?.value ? Buffer.from(firstChunk.value).toString("utf8") : "";
    expect(chunkText).toContain("event:");
    await reader?.cancel();
  } finally {
    await app.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
