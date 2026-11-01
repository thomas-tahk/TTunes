import { LocalDiskStorage } from "./storage.ts";
import { JsonTrackRepo } from "./repo.ts";
import { YouTubeIngest } from "./ingest.ts";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT) || 8787;
const UPLOAD_DIR = "uploads";
const DATA_FILE = "data/tracks.json";
const STAGING_DIR = "staging"; // holds extracted audio until the user confirms

const app = createApp({
  storage: new LocalDiskStorage(UPLOAD_DIR),
  repo: new JsonTrackRepo(DATA_FILE),
  ingest: new YouTubeIngest(STAGING_DIR),
  uploadDir: UPLOAD_DIR,
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
