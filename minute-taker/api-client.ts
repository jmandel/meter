export interface MeterClient {
  baseUrl: string;
}

export interface MeetingRunRecord {
  meeting_run_id: string;
  room_id: string;
  state: string;
  normalized_join_url: string;
  requested_by: string;
  bot_name: string | null;
  created_at_unix_ms: number;
}

interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }
  return await response.text();
}

export async function findActiveRun(
  client: MeterClient,
  zoomMeetingId: string,
): Promise<MeetingRunRecord | null> {
  const roomId = `zoom:${zoomMeetingId.replace(/\D/g, "")}`;
  const body = await fetchJson<ListResponse<MeetingRunRecord>>(
    `${client.baseUrl}/v1/meeting-runs?room_id=${encodeURIComponent(roomId)}&state=capturing&limit=1`,
  );
  return body.items[0] ?? null;
}

export async function fetchTranscriptMd(
  client: MeterClient,
  meetingRunId: string,
  since?: string,
): Promise<string> {
  let url = `${client.baseUrl}/v1/meeting-runs/${meetingRunId}/transcript.md?include=speech,joins,chat`;
  if (since) {
    url += `&since=${encodeURIComponent(since)}`;
  }
  return fetchText(url);
}

export async function fetchAttendeesMd(
  client: MeterClient,
  meetingRunId: string,
): Promise<string> {
  return fetchText(`${client.baseUrl}/v1/meeting-runs/${meetingRunId}/attendees.md`);
}

export async function fetchMeetingRun(
  client: MeterClient,
  meetingRunId: string,
): Promise<MeetingRunRecord> {
  const body = await fetchJson<{ meeting_run: MeetingRunRecord }>(
    `${client.baseUrl}/v1/meeting-runs/${meetingRunId}`,
  );
  return body.meeting_run;
}
