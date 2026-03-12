import { afterEach, expect, test } from "bun:test";

import { resolveTranscriptionProvider } from "./main";

afterEach(() => {
  delete process.env.METER_TRANSCRIPTION_PROVIDER;
  delete process.env.MISTRAL_API_KEY;
});

test("resolveTranscriptionProvider prefers explicit cli provider", () => {
  process.env.METER_TRANSCRIPTION_PROVIDER = "none";
  process.env.MISTRAL_API_KEY = "test-key";

  const args = new Map<string, string>([["--transcription-provider", "custom"]]);

  expect(resolveTranscriptionProvider(args)).toBe("custom");
});

test("resolveTranscriptionProvider uses configured env provider", () => {
  process.env.METER_TRANSCRIPTION_PROVIDER = "mistral";

  expect(resolveTranscriptionProvider(new Map())).toBe("mistral");
});

test("resolveTranscriptionProvider defaults to mistral when only the api key is present", () => {
  process.env.MISTRAL_API_KEY = "test-key";

  expect(resolveTranscriptionProvider(new Map())).toBe("mistral");
});

test("resolveTranscriptionProvider falls back to none with no transcription config", () => {
  expect(resolveTranscriptionProvider(new Map())).toBe("none");
});
