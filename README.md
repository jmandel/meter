# Zoom Meeting Capture

Automated Zoom meeting capture. A coordinator process manages isolated per-meeting workers that join via the Zoom web client using headless Chromium + CDP, capture audio in two streams (compressed WebM/Opus archive + 16 kHz PCM for live transcription), track active speakers and chat through DOM observation, and persist everything to local disk and a central SQLite index.

## Quick Start

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run server.ts --mode all
```

Open `http://127.0.0.1:3100` for the web dashboard, or use the API directly:

```bash
# health check
curl http://127.0.0.1:3100/v1/health

# start a capture
curl -X POST http://127.0.0.1:3100/v1/meeting-runs \
  -H 'content-type: application/json' \
  -d '{"join_url":"https://zoom.us/j/123456789?pwd=abc"}'

# list runs
curl http://127.0.0.1:3100/v1/meeting-runs

# stop a capture
curl -X POST http://127.0.0.1:3100/v1/meeting-runs/<id>/stop
```

## Web Dashboard

The built-in control panel at `/` provides:

- **Active jobs** with live browser screenshots (refreshed every 10s), state badges, worker status, event/speech/chat/audio stats, and recent transcript lines
- **History** table of completed, failed, and aborted meeting runs
- **New Capture** form to paste a Zoom link and start a job

The dashboard is a React app served via Bun's HTML import bundler (`ui/index.html` + `ui/app.tsx`). No separate build step required.

## Architecture

```
Client  ──POST /v1/meeting-runs──>  Coordinator (API + SQLite)
        <──SSE /v1/stream──────────        │
                                           │ spawns
                                    ┌──────┼──────┐
                                    ▼      ▼      ▼
                                 Worker  Worker  Worker
                                 Chrome  Chrome  Chrome
```

**Coordinator** (`src/coordinator.ts`) is long-lived. It owns the SQLite database, serves the public REST/SSE API, manages worker lifecycle, and serves the web dashboard.

**Workers** (`src/worker.ts`) are short-lived, one per meeting. Each launches a Chromium instance with an isolated profile, joins the Zoom web client, injects capture code, and runs a private loopback server for the injected browser runtime to send data back through.

**Injected browser code** (`src/bootstrap.ts`) runs inside the Zoom tab. It captures audio via `getDisplayMedia`, splits it into compressed archive chunks (MediaRecorder) and resampled PCM frames (AudioWorklet), observes the DOM for speaker changes and chat messages, and sends everything back to the owning worker over WebSocket/HTTP.

### Deployment Modes

| Mode | Flag | Description |
|------|------|-------------|
| `all` | `--mode all` | Combined coordinator + worker supervisor (default) |
| `api` | `--mode api` | Coordinator only, spawns workers as subprocesses |
| `worker` | `--mode worker` | Standalone worker, used when spawned by the coordinator |

## Configuration

All settings accept CLI flags or environment variables:

| Flag | Env | Default |
|------|-----|---------|
| `--mode` | `ZOOMER_MODE` | `all` |
| `--listen-host` | `ZOOMER_LISTEN_HOST` | `127.0.0.1` |
| `--listen-port` | `ZOOMER_LISTEN_PORT` | `3100` |
| `--data-root` | `ZOOMER_DATA_ROOT` | `./data` |
| `--chrome-bin` | `CHROME_BIN` | `/usr/bin/chromium` |
| `--default-bot-name` | `BOT_NAME` | `Meeting Bot` |
| `--transcription-provider` | `ZOOMER_TRANSCRIPTION_PROVIDER` | `none` |
| `--persist-live-pcm` | `ZOOMER_PERSIST_LIVE_PCM` | `true` |
| `--persist-archive-audio` | `ZOOMER_PERSIST_ARCHIVE_AUDIO` | `true` |

## Transcription

To enable realtime Mistral transcription:

```bash
export MISTRAL_API_KEY=...
export ZOOMER_TRANSCRIPTION_PROVIDER=mistral
bun run server.ts --mode all
```

The worker streams PCM to Mistral in realtime, persists raw provider messages to `transcripts/provider_raw.ndjson`, and emits normalized `transcription.segment.partial` and `transcription.segment.final` events. Final segments are projected into SQLite for full-text search.

If Mistral is unavailable, capture continues normally. Archive audio is always the source of truth.

Segment timestamps are converted from provider-relative offsets to absolute `ts_unix_ms` values by anchoring to the first PCM frame of the capture session. This enables speaker attribution by overlapping with `speaker_spans`.

## REST API

All public endpoints live under `/v1`. Responses are JSON. Lists use cursor-based pagination.

### Control
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Server health |
| `POST` | `/v1/meeting-runs` | Start a capture |
| `GET` | `/v1/meeting-runs` | List meeting runs |
| `GET` | `/v1/meeting-runs/:id` | Get one meeting run |
| `POST` | `/v1/meeting-runs/:id/stop` | Request graceful stop |
| `GET` | `/v1/meeting-runs/:id/screenshot` | Live browser screenshot (JPEG) |

### Query
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/events` | Events across all meetings |
| `GET` | `/v1/speech` | Transcription segments |
| `GET` | `/v1/chat` | Chat messages |
| `GET` | `/v1/search?q=...` | Full-text search (speech + chat) |
| `GET` | `/v1/rooms` | Zoom rooms |
| `GET` | `/v1/meeting-runs/:id/speakers` | Speaker spans |
| `GET` | `/v1/meeting-runs/:id/audio` | Archived audio chunks |
| `GET` | `/v1/meeting-runs/:id/artifacts` | Non-audio artifacts |

### Live Streaming (SSE)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/stream` | Global event stream |
| `GET` | `/v1/meeting-runs/:id/stream` | Meeting-scoped stream |
| `GET` | `/v1/rooms/:id/stream` | Room-scoped stream |

All SSE endpoints support `Last-Event-ID` and `after_event_id` for replay after reconnect.

## Data Layout

```
data/
  index.sqlite                          # Central query index
  coordinator/
    coordinator.log
    state/workers.json
  meetings/
    2026/2026-03-11/<meeting_run_id>/
      metadata.json                     # Immutable run config
      lifecycle.json                    # Current worker state
      events.ndjson                     # Append-only event journal (source of truth)
      errors.ndjson
      worker.log
      browser.log
      audio/
        archive/                        # Compressed WebM/Opus chunks
          manifest.json
          000001.webm
        live/                           # Raw 16kHz PCM (optional)
          pcm_manifest.json
          000001.pcm
      transcripts/
        provider_raw.ndjson             # Raw upstream messages
        segments.jsonl                  # Normalized segments
      artifacts/
        dom/
        screenshots/
```

SQLite is the query index. If normalized tables disagree with raw events, raw events win and projections are replayable.

## Project Layout

```
server.ts                   CLI entrypoint
ui/
  index.html                Dashboard (Bun HTML import, auto-bundled)
  app.tsx                   React dashboard app
src/
  main.ts                   Mode/config bootstrap
  coordinator.ts            REST, SSE, worker supervision, dashboard serving
  worker.ts                 Worker runtime and browser ingest server
  bootstrap.ts              Injected browser capture code
  database.ts               SQLite schema, projections, queries
  domain.ts                 TypeScript types (events, API, domain)
  files.ts                  File layout and metadata persistence
  zoom.ts                   Zoom URL normalization
  utils.ts                  IDs, time, crypto, networking helpers
  transcription/            Realtime transcription adapters
legacy-spike.ts             Original monolithic spike (reference only)
```

## Current Status

Working:
- Coordinator API with all three modes
- Per-meeting file layout with append-only journals
- Central SQLite event log with FTS5 search
- Full REST API for meeting runs, events, speech, chat, speakers, audio, rooms, artifacts, and search
- SSE with replay after reconnect
- Worker loopback ingest server (bootstrap, PCM, archive upload)
- Realtime Mistral transcription adapter
- Web dashboard with live screenshots and transcript display
- CDP screenshot proxy for active browser sessions

Not yet ported:
- Chromium/CDP Zoom join automation (the original spike's join flow needs integration into the worker runtime)
- End-to-end Mistral verification with a live key

## Spec

See [ARCHITECTURE_SPEC.md](./ARCHITECTURE_SPEC.md) for the full target-state specification including all TypeScript interfaces, event model, internal protocols, and acceptance criteria.
