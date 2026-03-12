The meeting has ended. Finalize the minutes in the current working directory.

This run uses the structured state / patch-log flow.

- `minutes.state.json` is canonical.
- `minutes.ops.jsonl` is append-only.
- `minutes.md` is rendered automatically.
- Use `./minute-op submit` for every mutation.

1. Process any remaining transcript content above (if any).

2. Mark the meeting as complete by submitting:

```bash
./minute-op submit <<'JSON'
{"op":"set_status","status":"completed"}
JSON
```

3. Add a **## Summary** section at the end with:
   - A concise 3-5 sentence overview of the meeting: what was discussed, what was decided, and what remains open.
   - Highlight the most important decisions and any deadlines mentioned.

4. Review action items:
   - Keep `TODO(Name): ...` items inline under the relevant topic sections.
   - Ensure todos are represented in structured state via `append_todo` operations and rendered inline.
   - Remove duplicates and fill in assignees or deadlines when identifiable.

5. Do a final pass on the full minutes for clarity and organization. Fix rough edges from the incremental updates, but do not flatten the topic structure into a generic summary.
