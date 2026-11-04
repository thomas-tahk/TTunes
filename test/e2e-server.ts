import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, fakeYtDlp, makeTestApp } from "./helpers.ts";
import type { YtDlpRunner } from "../server/ingest.ts";
import { parseSearchLines } from "../server/search.ts";

// Dev-only: real app on temp dirs with fake yt-dlp + search, for driving the UI without network.
const searchLines = readFileSync(join(FIXTURES, "ytsearch5.jsonl"), "utf8"); // hand-written, not real YouTube
const hits = parseSearchLines(searchLines);

// Info keyed by the video id in the url, so each search row yields a different confirm card.
const ytDlpByVideoId: YtDlpRunner = (url, outputTemplate) => {
  const id = new URL(url).searchParams.get("v");
  const hit = hits.find((h) => h.url.endsWith(`v=${id}`));
  if (!hit) throw new Error(`no fixture for ${url}`);
  const info = { title: hit.title, track: hit.title, artist: hit.channel ?? "Unknown", duration: hit.durationSec ?? 0 };
  return fakeYtDlp(info)(url, outputTemplate);
};

const port = Number(process.env.PORT) || 8787;
makeTestApp(ytDlpByVideoId, { search: async () => hits }).app.listen(port, () => console.log(`e2e server on ${port}`));
