import { describe, expect, test } from "bun:test";

import {
  applyPatchResponse,
  parsePatchResponse,
  splitTranscriptForMessages,
} from "./openrouter-patch";

describe("OpenRouter minute patch helpers", () => {
  test("splits transcript into stable blocks on line boundaries", () => {
    const transcript = Array.from({ length: 8 }, (_, index) => `[00:0${index} spk="A"] line ${index}`).join("\n");
    const blocks = splitTranscriptForMessages(transcript, 40);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.includes("[00:0"))).toBe(true);
  });

  test("parses and applies targeted patch edits", () => {
    const patch = parsePatchResponse({
      edits: [
        {
          op: "str_replace_once",
          old: "## Decisions\n- Old item",
          new: "## Decisions\n- Revised item",
        },
        {
          op: "insert_after_once",
          after: "## Decisions\n- Revised item",
          text: "\n- Added item",
        },
        {
          op: "append",
          text: "\n## Summary\nDone.",
        },
      ],
    });

    const next = applyPatchResponse("# Minutes\n\n## Decisions\n- Old item", patch);
    expect(next).toContain("- Revised item");
    expect(next).toContain("- Added item");
    expect(next).toContain("## Summary");
  });

  test("uses rewrite_file when provided", () => {
    const patch = parsePatchResponse({
      rewrite_file: "# Meeting Minutes\n\n## Summary\nFresh rewrite",
    });
    const next = applyPatchResponse("# old", patch);
    expect(next).toBe("# Meeting Minutes\n\n## Summary\nFresh rewrite");
  });

  test("accepts legacy single-op rewrite shape from provider output", () => {
    const patch = parsePatchResponse({
      operation: "rewrite_file",
      content: "# Meeting Minutes\n\n## Summary\nLegacy rewrite",
    });
    const next = applyPatchResponse("# old", patch);
    expect(next).toBe("# Meeting Minutes\n\n## Summary\nLegacy rewrite");
  });

  test("rejects objects that omit both edits and rewrite_file", () => {
    expect(() => parsePatchResponse({ nope: true })).toThrow(/must include \"edits\" or \"rewrite_file\"/);
  });

  test("rejects ambiguous exact-match edits", () => {
    const patch = parsePatchResponse({
      edits: [
        {
          op: "str_replace_once",
          old: "- same",
          new: "- new",
        },
      ],
    });
    expect(() => applyPatchResponse("# Minutes\n- same\n- same", patch)).toThrow(/expected 1 match/);
  });
});
