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
