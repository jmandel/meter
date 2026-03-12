export interface MinutesSnapshotLike {
  exists: boolean;
  content: string | null;
  mtimeMs: number;
}

export interface MinuteRescueState {
  lastSentChunkIndex: number;
  lastAcknowledgedChunkIndex: number;
  lastMinutesChangeAtMs: number;
  lastRescueAtMs: number;
  lastSnapshot: MinutesSnapshotLike;
}

export const STALE_MINUTES_RESCUE_MS = 2 * 60 * 1000;
export const STALE_MINUTES_RESCUE_COOLDOWN_MS = 60 * 1000;

export function createMinuteRescueState(
  initialSnapshot: MinutesSnapshotLike,
  nowMs: number,
): MinuteRescueState {
  return {
    lastSentChunkIndex: 0,
    lastAcknowledgedChunkIndex: 0,
    lastMinutesChangeAtMs: nowMs,
    lastRescueAtMs: 0,
    lastSnapshot: initialSnapshot,
  };
}

export function getUnacknowledgedChunkDepth(state: MinuteRescueState): number {
  return Math.max(0, state.lastSentChunkIndex - state.lastAcknowledgedChunkIndex);
}

export function getLargeQueueDepthThreshold(pollIntervalMs: number): number {
  const pollsPerTwoMinutes = Math.ceil(STALE_MINUTES_RESCUE_MS / Math.max(1, pollIntervalMs));
  return Math.max(5, Math.ceil(pollsPerTwoMinutes / 2));
}

export function noteMinutesSnapshot(
  state: MinuteRescueState,
  snapshot: MinutesSnapshotLike,
  nowMs: number,
): MinuteRescueState {
  const changed = snapshot.exists !== state.lastSnapshot.exists
    || snapshot.mtimeMs !== state.lastSnapshot.mtimeMs
    || snapshot.content !== state.lastSnapshot.content;
  if (!changed) {
    return state;
  }
  return {
    ...state,
    lastAcknowledgedChunkIndex: state.lastSentChunkIndex,
    lastMinutesChangeAtMs: nowMs,
    lastSnapshot: snapshot,
  };
}

export function noteChunkSent(
  state: MinuteRescueState,
  chunkIndex: number,
): MinuteRescueState {
  return {
    ...state,
    lastSentChunkIndex: Math.max(state.lastSentChunkIndex, chunkIndex),
  };
}

export function noteRescue(
  state: MinuteRescueState,
  nowMs: number,
): MinuteRescueState {
  return {
    ...state,
    lastRescueAtMs: nowMs,
  };
}

export function shouldRescueQueuedMinutes(
  state: MinuteRescueState,
  nowMs: number,
  pollIntervalMs: number,
): boolean {
  const staleForMs = nowMs - state.lastMinutesChangeAtMs;
  if (staleForMs <= STALE_MINUTES_RESCUE_MS) {
    return false;
  }
  if (state.lastRescueAtMs && nowMs - state.lastRescueAtMs <= STALE_MINUTES_RESCUE_COOLDOWN_MS) {
    return false;
  }
  return getUnacknowledgedChunkDepth(state) >= getLargeQueueDepthThreshold(pollIntervalMs);
}
