# Minute-Taker Patch Log Sketch

This is an exploration of a more robust alternative to treating `minutes.md` as the source of truth.

## Goal

Keep minutes in a typed in-memory/document state, and make the LLM emit append-only semantic operations against that state.

The Markdown file becomes a rendered view, not the canonical store.

## Proposed Core State

See [state.ts](/home/jmandel/hobby/zoomer/cdp-spike-codex/minute-taker/state.ts).

The core object is:

- meeting metadata
- attendee list
- ordered topical sections
- per-section bullets, decisions, and inline TODOs
- optional final summary

## Why This Is Better

- Operations are validateable before applying.
- Replay is deterministic.
- A bad model output can be rejected at the operation level instead of corrupting the whole Markdown document.
- Downstream clients can consume structured minutes directly without reparsing prose.
- `minutes.md` can still be rendered for humans from the same state.

## Example Append-Only Log

```json
{"op":"merge_attendees","attendees":[{"name":"Lloyd McKenzie","role":"chair","present":true}]}
{"op":"upsert_section","sectionId":"capstmt","title":"CapabilityStatement & Feature Framework","sourceRefs":[{"ts":"00:32","kind":"speech"}]}
{"op":"append_bullet","sectionId":"capstmt","text":"CapabilityStatement has become unwieldy in real deployments.","sourceRefs":[{"ts":"00:32","kind":"speech"}]}
{"op":"append_decision","sectionId":"capstmt","text":"Combined searches SHOULD default to SHOULD unless evidence supports SHALL.","sourceRefs":[{"ts":"04:53","kind":"speech"}]}
{"op":"append_todo","sectionId":"capstmt","assignee":"Cooper Thompson","text":"Submit the FHIR-34735 editorial PR.","sourceRefs":[{"ts":"02:53","kind":"speech"}]}
```

## Rendering Rule

Render Markdown from state with:

- topic sections
- concise bullets
- `Decision: ...` bullets for decisions
- inline `TODO(Name): ...` bullets for action items

## Migration Path

1. Keep the current poller and transcript chunk flow.
2. Change the model contract so it outputs semantic operations instead of rewriting `minutes.md`.
3. Apply operations with strict validation.
4. Render `minutes.md` from the resulting `MinutesState`.
5. Optionally persist the operation log as `minutes.ops.jsonl`.

## Open Questions

- Should section IDs be model-chosen strings or system-assigned stable IDs?
- Do we want a separate `openQuestions` collection in the state?
- Should attendee updates also capture join/leave timestamps, or is present/left enough for minutes?
- Do we want operation-level provenance beyond `sourceRefs`, such as chunk index or event ids?
