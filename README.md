# Meter

Meter is an experiment in turning a live Zoom meeting into a readable operational feed.

The point is not just to record a meeting. The point is to continuously turn what is happening inside a Zoom call into:

- legible transcript updates
- best-effort speaker attribution
- captured chat messages
- a durable audio artifact
- APIs that are easy to inspect manually or feed into another system

Meter captures Zoom meetings with Chromium/CDP, streams audio to Mistral in realtime, tracks active speakers and chat from the Zoom DOM, and saves a single MP3 archive when the run finishes.

The intended output is something closer to a live meeting log than a pile of low-level browser events: who appears to be speaking, what the transcript currently says, what showed up in chat, and what the meeting audio was.

## Project Goals

- Join a Zoom meeting automatically in an isolated worker.
- Capture audio once and use it for both realtime transcription and final archival output.
- Keep transcript updates easy to read while the meeting is still in progress.
- Use Zoom DOM state to improve speaker attribution and chat capture.
- Preserve raw events so the higher-level views can be replayed or rebuilt later.
- Expose the meeting state through simple APIs, SSE streams, and a lightweight operator UI.

Meter is therefore a bridge between raw capture and legible meeting state. It is meant to help a human operator or downstream LLM look at an in-progress meeting and understand the conversation without digging through browser internals.

## Requirements

- [Bun](https://bun.sh) 1.3+
- Chromium or Chrome
  - default lookup: `/usr/bin/chromium`
  - override with `CHROME_BIN`
- `ffmpeg`
  - required for the final MP3 archive
  - default lookup: `ffmpeg` on `PATH`
  - override with `FFMPEG_BIN`
- Optional: `MISTRAL_API_KEY` for realtime transcription
  - if `METER_TRANSCRIPTION_PROVIDER` is unset and this key is present, Meter now defaults to `mistral`
- Optional for integrated live minutes:
  - `tmux`
  - `claude` CLI on `PATH`

## Quick Start

```bash
bun install
export MISTRAL_API_KEY=...
# optional explicit override:
# export METER_TRANSCRIPTION_PROVIDER=mistral
bun run server.ts --mode all
```

Open `http://127.0.0.1:3100`.

Start a run from the dashboard or with the API:

```bash
curl -X POST http://127.0.0.1:3100/v1/meeting-runs \
  -H 'content-type: application/json' \
  -d '{"join_url":"https://zoom.us/j/123456789?pwd=abc"}'
```

Stop a run:

```bash
curl -X POST http://127.0.0.1:3100/v1/meeting-runs/<meeting_run_id>/stop
```

Coordination-only rescue commands:

```bash
bun run meter.ts status --meeting-run-id <meeting_run_id>
bun run meter.ts claim --meeting-run-id <meeting_run_id> --operator codex --reason "join_flow_stalled"
bun run meter.ts release --meeting-run-id <meeting_run_id> --operator codex
```

## What It Does

- Launches one worker per meeting run.
- Uses Chromium + CDP to join the Zoom web client.
- Captures meeting audio from `getDisplayMedia` with echo cancellation, noise suppression, and auto gain control disabled.
- Streams 16 kHz mono PCM frames to Mistral in realtime.
- Detects active speaker changes from the Zoom DOM and uses them for transcript attribution when the provider does not supply a speaker label.
- Records chat messages from the Zoom DOM.
- Writes one final MP3 archive at the end of the run.
- Exposes a live operator dashboard plus JSON and SSE APIs.

In practice, that means the main surfaces are:

- the live dashboard for active runs
- the per-meeting SSE stream for incremental updates
- the markdown transcript endpoint for a single readable transcript view
- the integrated minute-taker controls and live minutes panel in the dashboard
- stable recurring-meeting aliases keyed by Zoom meeting ID
- the stored event log and SQLite projection for later querying

## Architecture

```text
dashboard / API
       |
       v
coordinator (SQLite + SSE + worker supervision)
       |
       +--> worker (one per meeting)
               |
               +--> Chromium / Zoom tab
               +--> browser bootstrap
               +--> Mistral realtime websocket
               +--> final MP3 archive
```

### Coordinator

`src/coordinator.ts`

- Owns SQLite and the append-only event log projection model.
- Serves the REST API, SSE streams, transcript markdown endpoint, and dashboard.
- Spawns and tracks worker processes.

### Worker

`src/worker.ts`

- Launches Chromium with CDP.
- Joins the Zoom meeting.
- Injects the browser bootstrap.
- Accepts browser WebSocket PCM + DOM events.
- Feeds PCM to Mistral.
- Pipes the same PCM stream into `ffmpeg` and lands `audio/archive/meeting.mp3` on completion.
- Makes a best effort to click Zoom's Leave flow before closing Chromium.
- Monitors the Zoom tab for lost browser capture state and re-injects capture when the page drops it.
- Reconnects the Mistral realtime session if capture is still live but the provider session dies.

### Browser Bootstrap

`src/bootstrap.ts`

- Runs inside the Zoom tab.
- Captures audio via `getDisplayMedia`.
- Resamples audio to 16 kHz mono PCM with an `AudioWorklet`.
- Watches the DOM for active speaker and chat changes.
- Sends PCM and DOM events back to the owning worker over WebSocket.

## Outputs

Each meeting run gets its own directory under `data/meetings/.../<meeting_run_id>/`.

Important files:

- `events.ndjson`: append-only source of truth
- `index.sqlite`: central query index
- `audio/archive/meeting.mp3`: final meeting archive
- `audio/archive/manifest.json`: metadata for the MP3 artifact
- `transcripts/provider_raw.ndjson`: raw Mistral websocket messages
- `transcripts/segments.jsonl`: normalized transcript segments
- `browser.log` / `worker.log`: runtime logs

Optional debug output:

- `audio/live/*.pcm` if `METER_PERSIST_LIVE_PCM=true`

By default, live PCM is not persisted. The durable audio artifact is the final MP3.

## Useful Endpoints

- `GET /v1/health`
- `POST /v1/meeting-runs`
- `GET /v1/meeting-runs`
- `GET /v1/meeting-runs/:id`
- `POST /v1/meeting-runs/:id/stop`
- `GET /v1/meeting-runs/:id/rescue`
- `POST /v1/meeting-runs/:id/rescue/claim`
- `POST /v1/meeting-runs/:id/rescue/release`
- `GET /v1/meeting-runs/:id/screenshot`
- `GET /v1/meeting-runs/:id/speech`
- `GET /v1/meeting-runs/:id/speakers`
- `GET /v1/meeting-runs/:id/audio`
- `GET /v1/meeting-runs/:id/transcript.md`
- `GET /v1/meeting-runs/:id/minutes`
- `POST /v1/meeting-runs/:id/minutes/start`
- `POST /v1/meeting-runs/:id/minutes/restart`
- `POST /v1/meeting-runs/:id/minutes/stop`
- `GET /v1/meeting-runs/:id/minutes/view`
- `GET /v1/meeting-runs/:id/minutes.md`
- `GET /v1/meeting-runs/:id/minutes/versions`
- `GET /v1/meeting-runs/:id/minutes/stream`
- `GET /v1/zoom-meetings/:meeting_id`
- `GET /v1/zoom-meetings/:meeting_id/meeting-runs`
- `GET /v1/zoom-meetings/:meeting_id/transcript.md`
- `GET /v1/zoom-meetings/:meeting_id/minutes`
- `GET /v1/zoom-meetings/:meeting_id/minutes/view`
- `GET /v1/zoom-meetings/:meeting_id/minutes.md`
- `GET /v1/zoom-meetings/:meeting_id/minutes/stream`
- `GET /v1/zoom-meetings/:meeting_id/attendees`
- `GET /v1/zoom-meetings/:meeting_id/attendees.md`
- `GET /v1/zoom-meetings/:meeting_id/stream`
- `POST /v1/simulations`
- `GET /v1/stream`
- `GET /v1/meeting-runs/:id/stream`

The transcript markdown endpoint is intended for easy manual inspection and prompt insertion. It returns plain markdown as text, not a downloaded file. By default it includes speech, attendee joins/leaves, and chat in one time-ordered log.

Recurring-meeting aliases:

- `GET /v1/zoom-meetings/:meeting_id/...` resolves to the current active run for that Zoom meeting when one exists
- otherwise it resolves to the most recent recorded run for that meeting ID
- pass `?meeting_run_id=<id>` if you want to pin one historical run explicitly

Incremental transcript fetch:

- `GET /v1/meeting-runs/:id/transcript.md?since=<timestamp>`
- `GET /v1/zoom-meetings/:meeting_id/transcript.md?since=<timestamp>`
- pass `?include=speech,joins,chat` or any comma-separated subset such as `?include=speech,chat`
- each transcript row uses a compact bracket like `[00:24 chat id=1 from="Gino" to=Everyone]`
- use a visible line timestamp such as `00:30` as `since=`
- `since=` responses omit the transcript header and return entries from that timestamp onward
- pagination returns complete rendered turns, so the first returned speech line may repeat text you already saw if that turn kept growing

Example:

```text
[00:30 spk="Josh Mandel"] Here's the latest update.
```

Then:

```bash
curl 'http://127.0.0.1:3100/v1/zoom-meetings/2193058682/transcript.md?since=00:30'
```

Simulation kit:

- `POST /v1/simulations` starts a synthetic meeting run that emits normal event-log, SSE, transcript, chat, and attendee outputs without launching Zoom or Chromium
- simulation runs are tagged with `simulation`
- the response returns the created `meeting_run` plus direct transcript/attendee/stream URLs

Simple simulation DSL:

```text
meeting 2193058682
title "Weekly Sync Simulation"
speed 10

# Each +duration is relative to the previous step.
+0s attendee.join id=host-1 user_id=101 name="Alice Host" host=1
+0.5s say speaker="Alice Host" text="Welcome everyone."
+0.5s chat from="Alice Host" to="Everyone" text="Please review the notes."
+1s end
```

Simulation timing notes:

- each `+<duration>` is a delay after the previous step, not an absolute offset from meeting start
- keep startup joins compressed if you want transcript content to appear quickly
- use `speed` to accelerate long scripts without changing the scripted relative pacing

Supported simulation actions:

- `join`
- `capture.start`
- `capture.stop`
- `attendee.join`
- `attendee.leave`
- `speaker`
- `say`
- `chat`
- `console`
- `event`
- `end`

Simulation CLI helper:

```bash
bun run meter.ts simulate --script examples/simulations/weekly-sync.meter
```

## Integrated Minutes

Meter can now supervise the existing minute-taker from the main app instead of requiring it to be launched separately by hand.

Current behavior:

- each minute-taking job still runs in its own tmux session for transparency
- Meter watches `minutes.md` for settled changes and exposes them through API/SSE
- the main dashboard lets you opt into minutes at capture start, then stop, restart, and re-steer minutes with prompt edits while the meeting is live
- prompt drafts currently live in browser local storage, while the running prompt snapshot is stored with the minute job
- restarting minutes replaces the visible live `minutes.md` for that meeting run; older versions remain available only as debug history through `minute_versions`

The user-editable prompt surface is intentionally broad:

- users choose a named minute style template and can freely edit the resulting substantive minute-taking prompt body
- Meter keeps the low-level operational prompt contract locked

The live minutes panel in the dashboard tails the rendered Markdown from the managed minute-taker job. `GET /v1/meeting-runs/:id/minutes/view` opens a streaming viewer in a new tab, `GET /v1/meeting-runs/:id/minutes.md` returns the raw markdown, and `GET /v1/meeting-runs/:id/minutes/stream` streams settled snapshot updates keyed to the current minute job for that meeting run.

Minute-taker launch defaults:

- `METER_MINUTE_TAKER_MODEL`
  - optional default Claude model for managed minute jobs
- `METER_MINUTE_TAKER_EFFORT`
  - optional default Claude effort level for managed minute jobs: `low`, `medium`, `high`, or `max`
- the dashboard can override both per minute job, and browser-local prompt/model defaults can carry across meetings until reverted

## Configuration

Core settings:

| Flag | Env | Default |
|------|-----|---------|
| `--mode` | `METER_MODE` | `all` |
| `--listen-host` | `METER_LISTEN_HOST` | `127.0.0.1` |
| `--listen-port` | `METER_LISTEN_PORT` | `3100` |
| `--data-root` | `METER_DATA_ROOT` | `./data` |
| `--chrome-bin` | `CHROME_BIN` | `/usr/bin/chromium` |
| `--default-bot-name` | `BOT_NAME` | `Meeting Bot` |
| `--transcription-provider` | `METER_TRANSCRIPTION_PROVIDER` | `mistral` when `MISTRAL_API_KEY` is present, otherwise `none` |
| `--persist-archive-audio` | `METER_PERSIST_ARCHIVE_AUDIO` | `true` |
| `--persist-live-pcm` | `METER_PERSIST_LIVE_PCM` | `false` |

Mistral settings:

- `MISTRAL_API_KEY`
- `MISTRAL_REALTIME_MODEL`
- `MISTRAL_REALTIME_WS_URL`
- `MISTRAL_STREAMING_DELAY_MS`

Binary overrides:

- `CHROME_BIN`
- `FFMPEG_BIN`

Automated rescue hooks:

- `METER_AUTOMATED_RESCUE_COMMAND`
  - if set, the coordinator may spawn this local command when rescue heuristics say a run looks stuck
  - example: `codex exec --yolo`
  - launched locally via `bash -lc "$METER_AUTOMATED_RESCUE_COMMAND"` from the repo root
  - the fully rendered rescue prompt, including run-specific context, is streamed to the child over `stdin`
- `METER_AUTOMATED_RESCUE_ENABLED`
  - defaults to `true` when `METER_AUTOMATED_RESCUE_COMMAND` is set
- `METER_AUTOMATED_RESCUE_TIMEOUT_MS`
  - timeout for the spawned rescue agent
- `METER_AUTOMATED_RESCUE_COOLDOWN_MS`
  - minimum delay before retrying automated rescue for the same run
- `METER_AUTOMATED_RESCUE_MAX_ATTEMPTS`
  - max automated rescue launches per run
- `METER_AUTOMATED_RESCUE_OPERATOR`
  - operator name injected into the prompt/context

Each automated rescue attempt also gets:

- prompt/context/log files under `<meeting-run>/rescue/attempt-N.{prompt.md,context.json,log}`
- no run-specific environment variables are required by the child command
- the stdin prompt is intended to be self-contained for tools like `codex exec --yolo`

## Development

Run the app:

```bash
bun run server.ts --mode all
```

Run tests:

```bash
bun test
```

Manual coordination client:

```bash
bun run meter.ts start --join-url 'https://zoom.us/j/123456789?pwd=abc'
bun run meter.ts status --meeting-run-id <meeting_run_id>
```

The current test suite covers:

- append-only file helpers
- realtime Mistral transcript normalization
- speaker-label carry-through from Zoom DOM events
- backend-owned MP3 archive generation from PCM frames

## Notes

- The system relies on current Zoom web DOM selectors. Zoom UI changes can break join, speaker, or chat observation until selectors are updated.
- The MP3 archive is emitted when the run completes, not as rolling partial audio objects.
- If `ffmpeg` is missing, capture and transcription can still run, but the final MP3 archive will fail and the worker will emit `error.raised`.
- Automated rescue, if enabled, only launches an external local agent and feeds it prompt/context. Any direct page rescue should still happen over local CDP, not through Meter HTTP APIs.

See [ARCHITECTURE_SPEC.md](./ARCHITECTURE_SPEC.md) for the target-state spec and domain model.
