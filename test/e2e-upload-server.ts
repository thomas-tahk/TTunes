import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorage } from "../server/storage.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { YouTubeIngest } from "../server/ingest.ts";
import { createApp } from "../server/app.ts";

// Real API on temp dirs for the browser check.
const root = mkdtempSync(join(tmpdir(), "ttunes-e2e-"));
const uploadDir = join(root, "uploads");
const app = createApp({
  storage: new LocalDiskStorage(uploadDir),
  repo: new JsonTrackRepo(join(root, "tracks.json")),
  ingest: new YouTubeIngest(join(root, "staging")),
  uploadDir,
});
app.listen(8797, () => console.log("e2e API on 8797"));
