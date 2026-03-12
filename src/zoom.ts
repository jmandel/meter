export interface NormalizedZoomJoinUrl {
  room_id: string;
  provider_room_key: string;
  normalized_join_url: string;
}

export function normalizeZoomJoinUrl(rawUrl: string): NormalizedZoomJoinUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const match = url.pathname.match(/\/(?:j\/|wc\/join\/)(\d+)/);
  if (!match) {
    throw new Error(`Could not parse Zoom meeting id from URL: ${rawUrl}`);
  }

  const meetingId = match[1];
  const normalizedUrl = new URL(`https://app.zoom.us/wc/join/${meetingId}`);
  for (const param of ["pwd", "uname", "tk", "zak"]) {
    const value = url.searchParams.get(param);
    if (value) {
      normalizedUrl.searchParams.set(param, value);
    }
  }

  return {
    room_id: `zoom:${meetingId}`,
    provider_room_key: meetingId,
    normalized_join_url: normalizedUrl.toString(),
  };
}
