import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorage } from "../server/storage.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { YouTubeIngest } from "../server/ingest.ts";
import { createApp } from "../server/app.ts";
import { fakeYtDlp, FIXTURES } from "./helpers.ts";

// Dev-only: real app on temp dirs with a fake yt-dlp, for driving the UI without network.
const info = JSON.parse(readFileSync(join(FIXTURES, "ytdlp-info-topic.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "ttunes-e2e-"));
const uploadDir = join(root, "uploads");
const app = createApp({
  storage: new LocalDiskStorage(uploadDir),
  repo: new JsonTrackRepo(join(root, "data", "tracks.json")),
  ingest: new YouTubeIngest(join(root, "staging"), fakeYtDlp(info)),
  uploadDir,
});
app.listen(8787, () => console.log("e2e server on 8787"));
