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
  created_at?: string;
  started_at?: string | null;
  updated_at?: string;
}

export interface AttendeeSummaryRecord {
  attendee_key: string;
  meeting_run_id: string;
  room_id: string;
  display_name: string | null;
  aliases: string[];
  attendee_ids: string[];
  user_ids: number[];
  is_host: boolean;
  is_co_host: boolean;
  is_guest: boolean;
  present: boolean;
  join_count: number;
  leave_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
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

export async function fetchAttendees(
  client: MeterClient,
  meetingRunId: string,
): Promise<AttendeeSummaryRecord[]> {
  const body = await fetchJson<{ items: AttendeeSummaryRecord[] }>(
    `${client.baseUrl}/v1/meeting-runs/${meetingRunId}/attendees`,
  );
  return body.items;
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
