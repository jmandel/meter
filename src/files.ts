import path from "node:path";

import type {
  MeetingLifecycleFile,
  MeetingMetadataFile,
  MeetingRunPaths,
  MeetingRunState,
} from "./domain";
import { ensureDir, writeJsonFile } from "./utils";

export interface CoordinatorLayout {
  data_root: string;
  sqlite_path: string;
  coordinator_log_path: string;
  workers_state_path: string;
}

export interface MeetingRunFileLayout extends MeetingRunPaths {
  metadata_path: string;
  lifecycle_path: string;
  errors_path: string;
  transcripts_dir: string;
  transcripts_provider_raw_path: string;
  transcripts_segments_path: string;
  archive_manifest_path: string;
  live_pcm_manifest_path: string | null;
  artifacts_dir: string;
  dom_artifacts_dir: string;
  screenshots_dir: string;
}

function formatUtcParts(tsUnixMs: number): { year: string; day: string } {
  const date = new Date(tsUnixMs);
  const year = date.getUTCFullYear().toString();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return { year, day: `${year}-${month}-${day}` };
}

export function getCoordinatorLayout(dataRoot: string): CoordinatorLayout {
  return {
    data_root: dataRoot,
    sqlite_path: path.join(dataRoot, "index.sqlite"),
    coordinator_log_path: path.join(dataRoot, "coordinator", "coordinator.log"),
    workers_state_path: path.join(dataRoot, "coordinator", "state", "workers.json"),
  };
}

export async function ensureCoordinatorLayout(dataRoot: string): Promise<CoordinatorLayout> {
  const layout = getCoordinatorLayout(dataRoot);
  await ensureDir(path.dirname(layout.sqlite_path));
  await ensureDir(path.dirname(layout.coordinator_log_path));
  await ensureDir(path.dirname(layout.workers_state_path));
  await ensureDir(path.join(dataRoot, "meetings"));
  return layout;
}

export async function createMeetingRunLayout(
  dataRoot: string,
  meetingRunId: string,
  createdAtUnixMs: number,
  persistLivePcm: boolean,
): Promise<MeetingRunFileLayout> {
  const { year, day } = formatUtcParts(createdAtUnixMs);
  const meetingRoot = path.join(dataRoot, "meetings", year, day, meetingRunId);
  const archiveAudioDir = path.join(meetingRoot, "audio", "archive");
  const livePcmDir = persistLivePcm ? path.join(meetingRoot, "audio", "live") : null;
  const layout: MeetingRunFileLayout = {
    data_dir: meetingRoot,
    metadata_path: path.join(meetingRoot, "metadata.json"),
    lifecycle_path: path.join(meetingRoot, "lifecycle.json"),
    event_journal_path: path.join(meetingRoot, "events.ndjson"),
    worker_log_path: path.join(meetingRoot, "worker.log"),
    browser_log_path: path.join(meetingRoot, "browser.log"),
    errors_path: path.join(meetingRoot, "errors.ndjson"),
    archive_audio_dir: archiveAudioDir,
    live_pcm_dir: livePcmDir,
    transcripts_dir: path.join(meetingRoot, "transcripts"),
    transcripts_provider_raw_path: path.join(meetingRoot, "transcripts", "provider_raw.ndjson"),
    transcripts_segments_path: path.join(meetingRoot, "transcripts", "segments.jsonl"),
    archive_manifest_path: path.join(archiveAudioDir, "manifest.json"),
    live_pcm_manifest_path: livePcmDir ? path.join(livePcmDir, "pcm_manifest.json") : null,
    artifacts_dir: path.join(meetingRoot, "artifacts"),
    dom_artifacts_dir: path.join(meetingRoot, "artifacts", "dom"),
    screenshots_dir: path.join(meetingRoot, "artifacts", "screenshots"),
  };

  await ensureDir(layout.data_dir);
  await ensureDir(layout.archive_audio_dir);
  if (layout.live_pcm_dir) {
    await ensureDir(layout.live_pcm_dir);
  }
  await ensureDir(layout.transcripts_dir);
  await ensureDir(layout.dom_artifacts_dir);
  await ensureDir(layout.screenshots_dir);
  await Bun.write(layout.event_journal_path, "", { createPath: true });
  await Bun.write(layout.errors_path, "", { createPath: true });
  await Bun.write(layout.worker_log_path, "", { createPath: true });
  await Bun.write(layout.browser_log_path, "", { createPath: true });
  await writeJsonFile(layout.archive_manifest_path, { chunks: [] });
  if (layout.live_pcm_manifest_path) {
    await writeJsonFile(layout.live_pcm_manifest_path, { chunks: [] });
  }
  return layout;
}

export async function writeMeetingMetadata(
  layout: MeetingRunFileLayout,
  metadata: MeetingMetadataFile,
): Promise<void> {
  await writeJsonFile(layout.metadata_path, metadata);
}

export async function writeMeetingLifecycle(
  layout: MeetingRunFileLayout,
  lifecycle: MeetingLifecycleFile,
): Promise<void> {
  await writeJsonFile(layout.lifecycle_path, lifecycle);
}

export function buildLifecycleFile(
  meetingRunId: string,
  state: MeetingRunState,
  nowUnixMs: number,
): MeetingLifecycleFile {
  return {
    meeting_run_id: meetingRunId,
    state,
    worker_id: null,
    worker_pid: null,
    ingest_port: null,
    cdp_port: null,
    started_at_unix_ms: null,
    ended_at_unix_ms: null,
    updated_at_unix_ms: nowUnixMs,
    last_error: null,
  };
}
