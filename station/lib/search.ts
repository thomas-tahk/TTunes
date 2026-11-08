import { apiBase, apiKey, fetchVideos, throwApiError } from "./youtube.ts";

const MUSIC_CATEGORY = "10";

export interface SongResult {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSec: number;
  categoryId: string;
  thumbnail: string;
  isTopic: boolean;
}

export const isTopicChannel = (channelTitle: string): boolean => / - Topic$/.test(channelTitle);

/** Art tracks ("- Topic" channels) first, then Music (category 10), then the rest. Stable within each group; nothing is dropped. */
export function rankResults<T extends { isTopic: boolean; categoryId: string }>(results: readonly T[]): T[] {
  const tier = (r: T) => (r.isTopic ? 0 : r.categoryId === MUSIC_CATEGORY ? 1 : 2);
  return results.map((r, i) => ({ r, i })).sort((a, b) => tier(a.r) - tier(b.r) || a.i - b.i).map((x) => x.r);
}

interface SearchItem {
  id?: { videoId?: string };
  snippet?: { thumbnails?: { medium?: { url?: string }; default?: { url?: string } } };
}

async function searchItems(query: string, maxResults: number, strict: boolean): Promise<SearchItem[]> {
  const url = new URL(`${apiBase()}/search`);
  url.search = new URLSearchParams({
    part: "snippet", type: "video", videoEmbeddable: "true", maxResults: String(maxResults), q: query, key: apiKey(), ...(strict ? { safeSearch: "strict" } : {}),
  }).toString();
  const res = await fetch(url);
  if (!res.ok) return throwApiError(res, "search.list");
  const body = (await res.json()) as { items?: SearchItem[] };
  if (!Array.isArray(body.items)) throw new Error("YouTube search.list: response has no items array");
  return body.items;
}

/** Typed search (strict: listener search, safeSearch=strict): search.list, then videos.list for duration/category. Throws QuotaExceededError when the daily limit is hit. */
export async function searchSongs(query: string, opts: { maxResults?: number; strict?: boolean } = {}): Promise<SongResult[]> {
  const items = (await searchItems(query, opts.maxResults ?? 15, opts.strict ?? false)).filter((i) => i.id?.videoId);
  const info = await fetchVideos(items.map((i) => i.id!.videoId!));
  const results: SongResult[] = [];
  for (const item of items) {
    const id = item.id!.videoId!;
    const v = info.get(id);
    if (!v || !v.embeddable || !v.durationSec) continue;
    const t = item.snippet?.thumbnails;
    results.push({
      videoId: id, title: v.title, channelTitle: v.channelTitle, durationSec: v.durationSec, categoryId: v.categoryId,
      thumbnail: t?.medium?.url ?? t?.default?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      isTopic: isTopicChannel(v.channelTitle),
    });
  }
  return rankResults(results);
}
