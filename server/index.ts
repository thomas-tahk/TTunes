import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalDiskStorage } from "./storage.ts";
import { JsonTrackRepo } from "./repo.ts";
import { YouTubeIngest } from "./ingest.ts";
import { runRealYtSearch } from "./search.ts";
import { createApp } from "./app.ts";

const REPO_ROOT = resolve(import.meta.dirname, ".."); // so double-click works from any cwd
const HOST = "127.0.0.1"; // local-only: never reachable from the network
const PORT = Number(process.env.PORT) || 8787;
// TTUNES_DATA_DIR lets tests keep music/data out of the repo; default is the repo root.
const DATA_ROOT = process.env.TTUNES_DATA_DIR ? resolve(process.env.TTUNES_DATA_DIR) : REPO_ROOT;
const UPLOAD_DIR = join(DATA_ROOT, "uploads");
const DATA_FILE = join(DATA_ROOT, "data", "tracks.json");
const STAGING_DIR = join(DATA_ROOT, "staging"); // holds extracted audio until the user confirms
const DIST_DIR = join(REPO_ROOT, "dist");

const ingest = new YouTubeIngest(STAGING_DIR);
const app = createApp({
  storage: new LocalDiskStorage(UPLOAD_DIR),
  repo: new JsonTrackRepo(DATA_FILE),
  ingest,
  search: runRealYtSearch,
  uploadDir: UPLOAD_DIR,
  staticDir: existsSync(DIST_DIR) ? DIST_DIR : undefined,
});

const server = app.listen(PORT, HOST, () => {
  ingest.clearStaging(); // only after we own the port, so a second instance can't wipe a live one's files
  console.log(`TTunes server on http://localhost:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`TTunes is already running on port ${PORT}.`);
  process.exit(1);
});
