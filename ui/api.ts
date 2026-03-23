import type {
  EventRecord,
  HealthResponse,
  MeetingRunRecord,
  MinuteJobRecord,
  MinutePromptPresetRecord,
  MinuteVersionRecord,
} from "../src/domain";
import type { MinutePromptTemplate } from "../src/minute-prompts";
import type { UiMinuteProvider } from "./minute-prompt-core";

export type {
  EventRecord,
  HealthResponse,
  MeetingRunRecord,
  MinuteJobRecord,
  MinutePromptPresetRecord,
  MinuteVersionRecord,
};

export interface MinutePromptTemplatesResponse {
  default_provider?: UiMinuteProvider;
  default_openrouter_model?: string | null;
  items: MinutePromptTemplate[];
  saved_presets?: MinutePromptPresetRecord[];
}

export interface MinuteDetailsResponse {
  meeting_run_id: string;
  minute_job: MinuteJobRecord | null;
  latest_version: MinuteVersionRecord | null;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function deleteJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init, method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}
