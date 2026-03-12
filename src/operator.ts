import type {
  CreateMeetingRunRequest,
  MeetingRunRecord,
  RescueClaimRequest,
  RescueReleaseRequest,
  RescueStatusResponse,
  StartSimulationResponse,
} from "./domain";

function getArg(args: Map<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }
  return await response.json() as T;
}

async function fetchRescueStatus(baseUrl: string, meetingRunId: string): Promise<RescueStatusResponse> {
  const body = await fetchJson<{ rescue: RescueStatusResponse }>(`${baseUrl}/v1/meeting-runs/${meetingRunId}/rescue`);
  return body.rescue;
}

async function claimRun(baseUrl: string, meetingRunId: string, payload: RescueClaimRequest): Promise<RescueStatusResponse> {
  const body = await fetchJson<{ rescue: RescueStatusResponse }>(`${baseUrl}/v1/meeting-runs/${meetingRunId}/rescue/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return body.rescue;
}

async function releaseRun(baseUrl: string, meetingRunId: string, payload: RescueReleaseRequest): Promise<RescueStatusResponse> {
  const body = await fetchJson<{ rescue: RescueStatusResponse }>(`${baseUrl}/v1/meeting-runs/${meetingRunId}/rescue/release`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return body.rescue;
}

export async function runMeterCommand(args: Map<string, string>): Promise<void> {
  const baseUrl = getArg(args, "--base-url", "--coordinator-base-url") ?? process.env.METER_OPERATOR_BASE_URL ?? "http://127.0.0.1:3100";
  const action = (getArg(args, "--action") ?? "status").trim().toLowerCase();
  const meetingRunId = getArg(args, "--meeting-run-id", "--run-id");
  const operator = getArg(args, "--operator")?.trim() || process.env.USER || "codex";
  const reason = getArg(args, "--reason");
  const note = getArg(args, "--note");

  if (action === "start") {
    const joinUrl = getArg(args, "--join-url");
    if (!joinUrl) {
      throw new Error("--join-url is required for --action start");
    }
    const payload: CreateMeetingRunRequest = {
      join_url: joinUrl,
      bot_name: getArg(args, "--bot-name") ?? undefined,
      requested_by: operator,
    };
    const body = await fetchJson<{ meeting_run: MeetingRunRecord }>(`${baseUrl}/v1/meeting-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    console.log(JSON.stringify({
      meeting_run_id: body.meeting_run.meeting_run_id,
      room_id: body.meeting_run.room_id,
      state: body.meeting_run.state,
      rescue_url: `${baseUrl}/v1/meeting-runs/${body.meeting_run.meeting_run_id}/rescue`,
    }, null, 2));
    return;
  }

  if (action === "simulate") {
    const scriptPath = getArg(args, "--script", "--script-file");
    if (!scriptPath) {
      throw new Error("--script is required for --action simulate");
    }
    const script = await Bun.file(scriptPath).text();
    const body = await fetchJson<StartSimulationResponse>(`${baseUrl}/v1/simulations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        script,
        speed: getArg(args, "--speed") ? Number.parseFloat(getArg(args, "--speed") as string) : undefined,
        meeting_id: getArg(args, "--meeting-id"),
        title: getArg(args, "--title"),
        bot_name: getArg(args, "--bot-name"),
        requested_by: operator,
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (!meetingRunId) {
    throw new Error("--meeting-run-id is required for this action");
  }

  if (action === "status") {
    console.log(JSON.stringify(await fetchRescueStatus(baseUrl, meetingRunId), null, 2));
    return;
  }
  if (action === "claim") {
    console.log(JSON.stringify(await claimRun(baseUrl, meetingRunId, { operator, reason, note }), null, 2));
    return;
  }
  if (action === "release") {
    console.log(JSON.stringify(await releaseRun(baseUrl, meetingRunId, { operator, note }), null, 2));
    return;
  }

  throw new Error(`Unsupported meter action: ${action}`);
}
