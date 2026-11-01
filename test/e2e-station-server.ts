// Dev-only: API on temp dirs for browser checks. Run: npx tsx test/e2e-station-server.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorage } from "../server/storage.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { YouTubeIngest } from "../server/ingest.ts";
import { createApp } from "../server/app.ts";

const PORT = Number(process.env.PORT) || 8787;
const root = mkdtempSync(join(tmpdir(), "ttunes-e2e-"));
const uploadDir = join(root, "uploads");
const storage = new LocalDiskStorage(uploadDir);
const repo = new JsonTrackRepo(join(root, "data", "tracks.json"));
const ingest = new YouTubeIngest(join(root, "staging"), async () => ({ title: "unused" }));
createApp({ storage, repo, ingest, uploadDir }).listen(PORT, () => console.log(`e2e api on ${PORT}`));
