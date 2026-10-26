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

/** true when logged in (or auth is off), false on 401. */
export async function checkSession(): Promise<boolean> {
  const res = await fetch("/api/session");
  if (res.status === 401) return false;
  if (!res.ok) throw new Error("session check failed");
  return true;
}

export type LoginResult = "ok" | "wrong" | "locked";

export async function login(password: string): Promise<LoginResult> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return "ok";
  if (res.status === 401) return "wrong";
  if (res.status === 429) return "locked";
  throw new Error("login failed");
}
