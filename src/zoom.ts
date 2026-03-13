export interface NormalizedZoomJoinUrl {
  room_id: string;
  provider_room_key: string;
  normalized_join_url: string;
}

function buildNormalizedZoomJoinUrl(meetingId: string, sourceUrl?: URL | null): NormalizedZoomJoinUrl {
  const normalizedUrl = new URL(`https://app.zoom.us/wc/join/${meetingId}`);
  if (sourceUrl) {
    for (const param of ["pwd", "uname", "tk", "zak"]) {
      const value = sourceUrl.searchParams.get(param);
      if (value) {
        normalizedUrl.searchParams.set(param, value);
      }
    }
  }

  return {
    room_id: `zoom:${meetingId}`,
    provider_room_key: meetingId,
    normalized_join_url: normalizedUrl.toString(),
  };
}

function extractDirectMeetingId(rawInput: string): string | null {
  const compact = rawInput.replace(/[\s-]+/g, "");
  if (!/^\d{8,15}$/.test(compact)) {
    return null;
  }
  return compact;
}

export function normalizeZoomJoinUrl(rawUrl: string): NormalizedZoomJoinUrl {
  const trimmed = rawUrl.trim();
  const directMeetingId = extractDirectMeetingId(trimmed);
  if (directMeetingId) {
    return buildNormalizedZoomJoinUrl(directMeetingId);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Zoom meeting URL or meeting number: ${rawUrl}`);
  }

  const match = url.pathname.match(/\/(?:j\/|wc\/join\/)(\d+)/);
  if (!match) {
    throw new Error(`Could not parse Zoom meeting id from URL: ${rawUrl}`);
  }

  const meetingId = match[1];
  return buildNormalizedZoomJoinUrl(meetingId, url);
}
