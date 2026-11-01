import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, fakeYtDlp, makeTestApp } from "./helpers.ts";
import { parseSearchLines } from "../server/search.ts";

// Dev-only: real app on temp dirs with fake yt-dlp + search, for driving the UI without network.
const info = JSON.parse(readFileSync(join(FIXTURES, "ytdlp-info-topic.json"), "utf8"));
const searchLines = readFileSync(join(FIXTURES, "ytsearch5.jsonl"), "utf8"); // hand-written, not real YouTube
const port = Number(process.env.PORT) || 8787;
makeTestApp(fakeYtDlp(info), { search: async () => parseSearchLines(searchLines) }).app.listen(port, () =>
  console.log(`e2e server on ${port}`),
);
