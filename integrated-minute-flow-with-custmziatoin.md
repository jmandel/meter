# Integrated Minute Flow With Custmziatoin

## Goal

Integrate minute-taking into Meter's main app without losing the current strengths:

- separate tmux session per minute-taking job
- transparent agent behavior
- editable Markdown as the source artifact
- prompt flexibility for different meeting styles

The target result is:

- an end user can start and monitor minutes from the main Meter UI
- an end user can re-steer minutes mid-run by editing the prompt and restarting the minute job
- Meter manages the minute-taker job lifecycle
- live and final minutes are visible through the main API
- minute snapshots stream from Meter without requiring the LLM to post updates
- users can customize the substantive minute-taking prompt from the UI
- the operational contract stays locked and hidden from user edits

## Guiding Decisions

### 1. Keep the minute-taker out of process

Do not embed the LLM loop inside the Meter server.

Keep this model:

- Meter coordinator starts and supervises the minute-taker
- the minute-taker runs in its own tmux session
- the tmux session remains the primary observability and debugging surface

This preserves transparency and makes operator rescue/debug straightforward.

### 2. Keep minutes one-way and derived

Minutes are derived artifacts, not source truth.

Canonical source remains:

- transcript
- chat
- attendee join/leave
- event log

Minutes should never feed back into transcript state or event projections.

### 3. Do not ask the LLM to explicitly report updates

Meter should detect `minutes.md` changes itself.

Use:

- inotify-style directory watching on Linux when available
- a short settle window before accepting a new snapshot
- content hashing to suppress duplicates

### 4. Avoid over-modeling prompt customization

Do not split the user-facing prompt into many tiny fields.

Instead:

- keep a locked operational preamble owned by Meter
- expose the substantive prompt body for freeform user editing
- optionally expose a separate freeform finalization prompt body

## Proposed User Experience

### Main control UI

For each meeting run:

- toggle or explicit choice for whether to run minutes at all
- `Start minutes`
- `Stop minutes`
- `Restart minutes with current prompt`
- `Open tmux session info`
- `Open current minutes`
- `Open minute stream`
- integrated live minutes panel inside the core Bun/React app
- current minute job status
- last minutes update time
- current prompt/template label
- current prompt dirty state if the user has edited but not restarted

This should live directly in the main Meter dashboard rather than in a separate preview tool.
The existing standalone preview flow remains useful for debugging, but the primary user path should be in the Bun/React app.

### Prompt editing

In the UI, users see:

- `Minute prompt`
- `Finalization prompt`

These are editable freeform textareas representing the user-controlled portion of the prompt.

Users should be able to:

- edit the prompt before starting minutes
- edit the prompt while minutes are already running
- choose whether to leave the current minute job alone or restart it with the new prompt
- see exactly which prompt version the current job is using versus their unsaved or un-applied draft

Users do not edit:

- the file-writing contract
- transcript chunk semantics
- overlap semantics
- polling/streaming mechanics
- filenames and working directory rules

### Storage model for prompt customization

Phase 1:

- draft prompt bodies stored in browser `localStorage`
- chosen prompt bodies sent to Meter when starting a minute job
- Meter snapshots the resolved prompts into the run directory and DB
- if the user edits the prompt during a running minute job, keep the draft in the browser until they choose `Restart minutes`

Phase 2:

- named prompt templates stored in SQLite
- optional personal/shared templates
- UI lets users pick, clone, rename, and edit templates

## Proposed Architecture

```text
dashboard / API
      |
      v
coordinator
  |- worker supervision
  |- minute job supervision
  |- minute file watcher
  |- minute snapshot persistence
  |- minute SSE/API
      |
      +--> worker (Zoom capture)
      |
      +--> minute-taker (tmux + claude/codex/etc)
             |
             +--> writes minutes.md into run dir
```

## Minute Job Model

Add a server-managed minute job per `meeting_run_id`.

Suggested job states:

- `idle`
- `starting`
- `running`
- `stopping`
- `restarting`
- `completed`
- `failed`

Suggested metadata:

- `meeting_run_id`
- `status`
- `tmux_session_name`
- `started_at`
- `ended_at`
- `prompt_label`
- `prompt_hash`
- `user_prompt_body`
- `user_final_prompt_body`
- `provider_command`
- `working_dir`
- `last_minutes_update_at`
- `last_error`

This can live either:

- in a dedicated `minute_jobs` table
- or as a first pass in a JSON column/artifact-like table

Recommendation: use a dedicated table because job state is operational, not just archival.

### Re-steering semantics

Re-steering should mean:

- the user edits the substantive prompt body in the core UI
- Meter preserves the edited draft separately from the current running job
- when the user chooses `Restart minutes`, Meter stops the current minute job and launches a new minute job for the same `meeting_run_id`
- the new job starts from the live transcript state and the same `minutes/<meeting_run_id>/` working directory unless we explicitly decide to roll over to a sibling attempt directory

Recommended initial behavior:

- keep the visible `minutes.md` file as the latest active output
- on restart, allow the new minute job to replace the previous live minutes output
- append a new `minute_job` row for each restart attempt rather than mutating one row forever, but do not require preserving old minute text as a user-facing artifact

That gives:

- clean auditability of prompt changes
- restart history
- the option to compare minute quality across prompt revisions later if we choose to retain that data

## Minute Snapshot Model

Persist minute snapshots separately from the job row.

Suggested schema:

### `minute_jobs`

- `minute_job_id`
- `meeting_run_id`
- `room_id`
- `status`
- `tmux_session_name`
- `generator_command`
- `prompt_label`
- `prompt_hash`
- `user_prompt_body`
- `user_final_prompt_body`
- `restarted_from_minute_job_id`
- `started_at_unix_ms`
- `ended_at_unix_ms`
- `last_update_at_unix_ms`
- `last_snapshot_seq`
- `last_error`

### `minute_versions`

- `minute_version_id`
- `minute_job_id`
- `meeting_run_id`
- `seq`
- `status` (`live` or `final`)
- `content_markdown`
- `content_sha256`
- `source_since_ts`
- `source_through_ts`
- `created_at_unix_ms`

Notes:

- persist only settled snapshots, not every editor keystroke
- dedupe by `content_sha256`
- `source_*` fields are best-effort provenance from the minute-taker poll loop
- `minute_versions` should point at the specific `minute_job_id` that produced them if we retain them across restarts; this should be treated as an implementation option, not a user-facing requirement

## Filesystem Layout

Per minute job, keep the existing run-local working directory pattern:

- `minutes/<meeting_run_id>/minutes.md`
- `minutes/<meeting_run_id>/chunks/`
- `minutes/<meeting_run_id>/run.json`
- `minutes/<meeting_run_id>/.system-prompt.txt`
- optional: `minutes/<meeting_run_id>/prompt-user.txt`
- optional: `minutes/<meeting_run_id>/prompt-final-user.txt`
- optional: `minutes/<meeting_run_id>/attempts/<minute_job_id>/` for tmux/job-specific logs if the shared root gets too messy

Meter should own the run dir creation and pass it to the minute-taker.

Recommendation:

- keep `minutes.md` at the run root as the current visible document
- store per-job prompt snapshots and logs under a per-attempt subdirectory if needed
- avoid changing the human-facing preview path on every restart

## Watching `minutes.md`

### Recommended mechanism

Watch the minute job working directory, not just `minutes.md`.

Reasons:

- some tools edit in place
- some tools write temp files and rename over the target
- directory-level watching catches both

### Acceptance algorithm

When Meter sees a relevant write event:

1. start or reset a short debounce timer
2. after debounce, read `minutes.md`
3. compute content hash
4. if unchanged from the last accepted snapshot, ignore it
5. if changed, persist a new `minute_versions` row
6. emit a `minutes.updated` SSE event

Recommended debounce window:

- start with `750ms`
- make configurable if needed

Fallback:

- if native watching is unavailable, allow a low-frequency polling fallback
- but Linux/inotify should be the preferred path here

## Prompt Composition

### Locked operational preamble

Meter-owned, not user-editable.

Contains:

- what file to write
- transcript format semantics
- overlap semantics
- handling of repeated growing speaker turns
- allowed files/tools
- finalization contract

### User-editable prompt body

User-controlled.

Contains things like:

- style
- section structure
- jargon preferences
- attendee formatting preferences
- tracker/Jira normalization preferences
- examples
- how much detail to keep

### Finalization prompt body

Optional separate user-editable body for the end-of-meeting cleanup pass.

### Resolved prompt

At job launch:

- Meter builds `resolved_system_prompt = locked_preamble + user_prompt_body`
- Meter builds `resolved_final_prompt = locked_final_preamble + user_final_prompt_body`
- Meter snapshots both into the run dir and DB

This makes behavior reproducible even if templates change later.

## APIs

### Job lifecycle

- `POST /v1/meeting-runs/:id/minutes/start`
- `POST /v1/meeting-runs/:id/minutes/stop`
- `POST /v1/meeting-runs/:id/minutes/restart`
- `GET /v1/meeting-runs/:id/minutes`

Room-scoped alias:

- `GET /v1/zoom-meetings/:meeting_id/minutes`

### Content

- `GET /v1/meeting-runs/:id/minutes.md`
- `GET /v1/meeting-runs/:id/minutes/versions`
- `GET /v1/meeting-runs/:id/minutes/stream`

Room-scoped alias:

- `GET /v1/zoom-meetings/:meeting_id/minutes.md`
- `GET /v1/zoom-meetings/:meeting_id/minutes/stream`

Resolution rule for room-scoped aliases should match transcript aliases:

- active run if one exists
- otherwise most recent run
- optional `?meeting_run_id=` to pin a historical run

### Prompt templates

Phase 1:

- no server template CRUD required
- `minutes/start` and `minutes/restart` accept inline prompt bodies

Example request body:

```json
{
  "prompt_label": "FHIR WG dense technical notes",
  "user_prompt_body": "Write compact, technical minutes with inline tracker links...",
  "user_final_prompt_body": "At the end, add a concise summary..."
}
```

`minutes/restart` should use the same shape, plus optionally:

```json
{
  "prompt_label": "FHIR WG dense technical notes v2",
  "user_prompt_body": "Be denser and track open design tensions explicitly...",
  "user_final_prompt_body": "Keep the final summary under six bullets...",
  "reason": "user_resteer"
}
```

Phase 2:

- `GET /v1/minute-templates`
- `POST /v1/minute-templates`
- `PATCH /v1/minute-templates/:id`
- `DELETE /v1/minute-templates/:id`

## SSE Events

Add these event kinds:

- `minutes.job.started`
- `minutes.job.restarting`
- `minutes.updated`
- `minutes.finalized`
- `minutes.job.failed`
- `minutes.job.stopped`

Suggested `minutes.updated` payload:

```json
{
  "meeting_run_id": "019ce2cf-bcd2-78af-bf20-2a0a34136cc0",
  "minute_job_id": "019ce999-...",
  "version_seq": 7,
  "status": "live",
  "content_markdown": "# Meeting Minutes ...",
  "content_sha256": "abc123...",
  "updated_at": "2026-03-12T18:10:22.000Z"
}
```

The stream should emit full settled snapshots, not diffs.

## Minute-Taker Invocation

Meter should launch the minute-taker as a supervised child process and keep the tmux session model.

Suggested launch flow:

1. create minute job row
2. create `minutes/<meeting_run_id>/`
3. write prompt snapshot files
4. create tmux session
5. launch minute-taker process inside tmux
6. start filesystem watcher
7. expose job state via API/UI

The existing standalone CLI should remain usable for manual/debug use, but the main path should be server-managed launch.

Suggested restart flow:

1. user edits prompt in the main UI
2. user clicks `Restart minutes`
3. Meter marks the current minute job `stopping`
4. Meter shuts down the existing tmux-managed minute-taker
5. Meter creates a new `minute_job` row linked by `restarted_from_minute_job_id`
6. Meter writes the new prompt snapshot files
7. Meter launches the replacement tmux session
8. file watching continues and the new job becomes the sole active writer for visible `minutes.md`

## UI Changes

### Meeting run card

Add:

- `Minutes` on/off control or `Start minutes` action before launch
- `Start minutes`
- `Stop minutes`
- `Restart minutes`
- status pill for minutes
- last updated time
- link to current `minutes.md`
- link to tmux session label

### Minutes panel

For an active run, show:

- latest rendered minutes
- live tail behavior similar to the current standalone preview UX
- prompt label
- current job prompt hash/version
- editable prompt textareas
- `Save draft`
- `Restart with draft`
- indication when draft differs from the currently running prompt
- link to transcript
- link to minute stream endpoint

Behavior:

- the panel should auto-refresh or subscribe via SSE for minute updates
- it should highlight newly added minute content similarly to the current preview
- it should not require opening a separate preview server to watch minutes live

### Prompt editor UI

Simple initial version:

- textarea for `Minute prompt`
- textarea for `Finalization prompt`
- local draft save in browser
- button to start minute job with those prompt bodies
- button to restart the active minute job with the current draft
- visible note showing whether the running job is using this exact draft or an older prompt snapshot

Later:

- named templates
- clone template
- diff template vs current draft

## Testing Plan

### Unit

- prompt composition: locked preamble + user body
- minute watcher debounce and dedupe
- minute version persistence
- room-scoped minutes alias resolution

### Integration

- start minute job from API
- verify tmux session created
- write synthetic `minutes.md` updates and verify snapshots persist
- verify `minutes.updated` SSE emission
- verify finalization writes a final snapshot
- verify room alias serves active-or-latest minutes
- restart a running minute job with a changed prompt and verify a new `minute_job` row is created
- verify the UI can distinguish running-prompt state from edited-but-not-applied draft state
- verify restart replaces the active visible `minutes.md` content path cleanly

### End-to-end

- simulation-backed meeting run
- server-managed minute-taker launch
- transcript chunks flow
- `minutes.md` updates appear in API and SSE

## Rollout Phases

### Phase 1: Managed jobs + live snapshots

- add `minute_jobs`
- add `minute_versions`
- add `minutes/start`, `minutes/stop`, `minutes.md`, `minutes/stream`
- launch minute-taker from Meter
- detect `minutes.md` changes via filesystem watcher
- expose status in UI
- prompt customization via localStorage + inline request bodies

This is the highest-value milestone.

### Phase 2: Template management

- add SQLite-backed named templates
- add template picker/editor in UI
- persist prompt labels and snapshots cleanly

### Phase 3: operational polish

- restart failed minute jobs
- autostart minutes on meeting start if configured
- show tmux session metadata and preview link in UI
- richer logs and failure diagnostics

## Recommended Initial Scope

Implement first:

1. server-managed minute job lifecycle
2. directory watcher + settled snapshot persistence
3. `minutes.md` and `minutes/stream` APIs
4. Bun/React UI start/stop/restart/status controls
5. freeform prompt body editing with localStorage drafts
6. integrated live minutes panel in the main UI

Do not block this on:

- DB-backed named templates
- multi-user template sharing
- structured minutes schemas
- patch/diff-based minutes updates

## Open Questions

### 1. Should minutes autostart?

Recommendation:

- default `off`
- optional per-run toggle in UI
- optional env/config for default-on

### 2. Should Meter persist every live snapshot forever?

Recommendation:

- yes for now, because volume should stay manageable
- revisit retention later if needed

### 3. Should the minute-taker still be runnable manually?

Recommendation:

- yes
- keep the CLI for direct debugging and experimentation
- but treat the server-managed launch path as primary

### 4. Should re-steering mutate one minute job or create a new one?

Recommendation:

- create a new `minute_job` row on restart
- link it back to the previous job
- keep `minutes.md` as the current visible surface
- do not require preserving the previous minute text after restart unless we explicitly choose to retain it for debugging or provenance

That keeps the control flow clean while preserving a simple user-facing file.

## Summary

The clean design is:

- Meter owns minute job orchestration
- tmux remains the transparent execution surface
- the LLM keeps editing Markdown directly
- Meter watches `minutes.md`, snapshots meaningful changes, and streams them
- user customization is freeform prompt-body editing, not a pile of tiny knobs
- users can re-steer a live minute-taking session by editing the prompt and restarting the job
- the core Bun/React app becomes the primary place to decide whether to run minutes, customize prompts, restart jobs, and live-tail the rendered minutes
- the capture/transcript pipeline stays canonical and one-way

That gives integrated live minutes without sacrificing the qualities that make the current spike usable.
