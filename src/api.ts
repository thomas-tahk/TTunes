import type { StationView, Track } from "./types.ts";

/** Thrown by api helpers on a 401: the session expired or was revoked. */
export class UnauthorizedError extends Error {
  constructor() {
    super("login required");
  }
}

// App registers this to flip back to the login screen on any mid-session 401.
let unauthorizedHandler: () => void = () => {};
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

function guard(res: Response): Response {
  if (res.status === 401) {
    unauthorizedHandler();
    throw new UnauthorizedError();
  }
  return res;
}

export async function fetchTracks(): Promise<Track[]> {
  const res = guard(await fetch("/api/tracks"));
  if (!res.ok) throw new Error("failed to load tracks");
  return res.json();
}

export async function uploadTrack(file: File): Promise<Track> {
  const body = new FormData();
  body.append("file", file);
  const res = guard(await fetch("/api/tracks", { method: "POST", body }));
  if (!res.ok) throw new Error(`upload failed: ${file.name}`);
  return res.json();
}

export async function deleteTrack(id: string): Promise<void> {
  const res = guard(await fetch(`/api/tracks/${id}`, { method: "DELETE" }));
  if (!res.ok) throw new Error("delete failed");
}

/** An <audio> load failed: if it was because the session is gone, flip to login. */
export function recheckSession(): void {
  checkSession().then(
    (ok) => {
      if (!ok) unauthorizedHandler();
    },
    () => {},
  );
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

// ---- Station (server-owned now playing / queue; see server/station-routes.ts) ----

/** POST /api/station/queue answered 409: the queue is at its cap. */
export class QueueFullError extends Error {
  constructor() {
    super("queue full");
  }
}

async function stationCall(method: string, path: string, body?: unknown): Promise<StationView> {
  const res = guard(
    await fetch(`/api/station${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (res.status === 409 && path === "/queue") throw new QueueFullError();
  if (!res.ok) throw new Error(`station ${method} ${path} failed (${res.status})`);
  return res.json();
}

export const fetchStation = () => stationCall("GET", "");

export interface NowPlayingReport {
  trackId: string;
  offsetSec: number;
  playing: boolean;
  /** The track this device is playing, so a report from a device the station has left is ignored. */
  fromTrackId?: string;
}
export const reportNowPlaying = (report: NowPlayingReport) => stationCall("PUT", "/now-playing", report);

/** With fromTrackId, a second `ended` for the same track is a no-op (`stale: true`). */
export const stationNext = (fromTrackId?: string) =>
  stationCall("POST", "/next", fromTrackId === undefined ? {} : { fromTrackId });

export const stationPlayNow = (trackId: string) => stationCall("POST", "/play-now", { trackId });

export const stationEnqueue = (trackId: string) => stationCall("POST", "/queue", { trackId });

/** 409 "queue changed" if entry `index` is no longer `trackId`. */
export const stationDequeue = (index: number, trackId: string) =>
  stationCall("DELETE", `/queue/${index}?trackId=${encodeURIComponent(trackId)}`);

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
