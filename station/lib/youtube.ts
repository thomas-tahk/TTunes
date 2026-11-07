// YouTube Data API v3 client. videos.list costs 1 quota unit per call and takes up to 50 ids.
const ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
export const MAX_IDS_PER_CALL = 50;

export interface VideoInfo {
  videoId: string;
  title: string;
  durationSec: number | null; // null: YouTube sent a duration we cannot parse
  embeddable: boolean;
}

/** "PT1H2M3S" -> 3723. Live/upcoming videos ("P0D") give 0. */
export function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) throw new Error(`unparseable YouTube duration: ${iso}`);
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number];
  return d * 86400 + h * 3600 + min * 60 + s;
}

interface ApiItem {
  id: string;
  snippet: { title: string };
  contentDetails: { duration: string };
  status: { embeddable: boolean };
}

function safeDuration(item: ApiItem): number | null {
  try {
    return parseIsoDuration(item.contentDetails.duration);
  } catch (error) {
    console.error(`video ${item.id}: ${(error as Error).message}`);
    return null;
  }
}

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  return key;
}

async function fetchBatch(ids: string[], key: string): Promise<ApiItem[]> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ part: "snippet,contentDetails,status", id: ids.join(","), key }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube videos.list failed: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: ApiItem[] };
  if (!Array.isArray(body.items)) throw new Error("YouTube videos.list: response has no items array");
  return body.items;
}

/** Looks up videos. Ids YouTube does not return (deleted, private) are absent from the result. Throws on any API failure. */
export async function fetchVideos(ids: string[]): Promise<Map<string, VideoInfo>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, VideoInfo>();
  if (unique.length === 0) return found;
  const key = apiKey();
  for (let i = 0; i < unique.length; i += MAX_IDS_PER_CALL) {
    for (const item of await fetchBatch(unique.slice(i, i + MAX_IDS_PER_CALL), key)) {
      found.set(item.id, { videoId: item.id, title: item.snippet.title, durationSec: safeDuration(item), embeddable: item.status.embeddable });
    }
  }
  return found;
}
