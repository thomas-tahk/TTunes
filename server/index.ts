import { createApp } from "./app.ts";
import { LocalDiskStorage } from "./storage.ts";
import { JsonTrackRepo } from "./repo.ts";

const PORT = Number(process.env.PORT ?? 8787);
const STORAGE_DIR = "uploads"; // local adapter; swaps to R2 later (design spec §9)
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as STORAGE_DIR so put() is a rename
const DATA_FILE = "data/tracks.json"; // local adapter; swaps to Postgres later

const app = createApp({
  repo: new JsonTrackRepo(DATA_FILE),
  storage: new LocalDiskStorage(STORAGE_DIR),
  uploadDir: INCOMING_DIR,
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
