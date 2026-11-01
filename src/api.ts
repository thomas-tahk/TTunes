import type { Track } from "./types.ts";

export async function fetchTracks(): Promise<Track[]> {
  const res = await fetch("/api/tracks");
  if (!res.ok) throw new Error("failed to load tracks");
  return res.json();
}

export async function uploadTrack(file: File): Promise<Track> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/tracks", { method: "POST", body });
  if (!res.ok) throw new Error(`upload failed: ${file.name}`);
  return res.json();
}

export async function deleteTrack(id: string): Promise<void> {
  const res = await fetch(`/api/tracks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("delete failed");
}

export function audioUrl(id: string): string {
  return `/audio/${id}`;
}

// --- YouTube ingest ---

export interface StagedIngest {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  uploader: string | null;
  durationSec: number | null;
  bitrate: number | null;
  format: string | null;
  sizeBytes: number;
  warnings: string[];
}

export interface StagedEdits {
  title: string;
  artist: string;
  album: string;
}

export async function ingestYouTube(url: string): Promise<StagedIngest> {
  const res = await fetch("/api/ingest/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't fetch that link.");
  return res.json();
}

export async function commitIngest(id: string, edits: StagedEdits): Promise<Track> {
  const res = await fetch(`/api/ingest/youtube/${id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
  if (!res.ok) throw new Error("Couldn't add that track.");
  return res.json();
}

export async function discardIngest(id: string): Promise<void> {
  await fetch(`/api/ingest/youtube/${id}`, { method: "DELETE" });
}

export function stagedAudioUrl(id: string): string {
  return `/api/ingest/youtube/${id}/audio`;
}
