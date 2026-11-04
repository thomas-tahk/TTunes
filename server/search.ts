import { spawn } from "node:child_process";
import { YTDLP_MISSING, YTDLP_UPGRADE_HINT } from "./ytdlp-errors.ts";

// YouTube search via yt-dlp (design spec §6). Results are only candidates —
// the user picks one, which then goes through the normal stage/confirm flow.

export interface YtSearchHit {
  url: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
}

/** Runs a YouTube search and returns candidate videos. Tests inject a fake. */
export type YtSearchRunner = (query: string) => Promise<YtSearchHit[]>;

export class SearchError extends Error {}

const SEARCH_TIMEOUT_MS = 30_000;
const RESULT_COUNT = 5;

interface FlatEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number | null;
}

/** Parses yt-dlp --flat-playlist --dump-json output (one JSON object per line). */
export function parseSearchLines(text: string): YtSearchHit[] {
  const hits: YtSearchHit[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const hit = toHit(parseLine(line));
    if (hit) hits.push(hit);
  }
  return hits;
}

function parseLine(line: string): FlatEntry {
  try {
    return JSON.parse(line) as FlatEntry;
  } catch {
    throw new SearchError("Couldn't read the search results.");
  }
}

function toHit(entry: FlatEntry): YtSearchHit | null {
  const url = entry.url ?? entry.webpage_url ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
  if (!url || !entry.title) return null;
  return {
    url,
    title: entry.title,
    channel: entry.channel ?? entry.uploader ?? null,
    durationSec: typeof entry.duration === "number" ? Math.round(entry.duration) : null,
  };
}

export function runRealYtSearch(query: string): Promise<YtSearchHit[]> {
  const args = [`ytsearch${RESULT_COUNT}:${query}`, "--flat-playlist", "--dump-json", "--no-warnings"];
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("yt-dlp", args, { timeout: SEARCH_TIMEOUT_MS });
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.on("error", () => rejectPromise(new SearchError(YTDLP_MISSING)));
    proc.on("close", (code) => {
      if (code !== 0) return rejectPromise(new SearchError("YouTube search failed." + YTDLP_UPGRADE_HINT));
      try {
        resolvePromise(parseSearchLines(stdout));
      } catch (err) {
        rejectPromise(err);
      }
    });
  });
}
