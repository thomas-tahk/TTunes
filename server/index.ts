import { createApp } from "./app.ts";
import { createStorageFromEnv, verifyStorage } from "./s3-storage.ts";
import { JsonTrackRepo } from "./repo.ts";
import type { StorageAdapter } from "./storage.ts";

const PORT = Number(process.env.PORT ?? 8787);
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as local storage (uploads/) so put() is a rename
const DATA_FILE = "data/tracks.json"; // local adapter; swaps to Postgres later

// S3/R2 when S3_BUCKET is set, else local uploads/. Misconfig fails startup, not every request.
let storage: StorageAdapter;
try {
  storage = createStorageFromEnv();
  await verifyStorage(storage);
} catch (err) {
  console.error(`TTunes: storage misconfigured: ${(err as Error).message}`);
  process.exit(1);
}

const app = createApp({
  repo: new JsonTrackRepo(DATA_FILE),
  storage,
  uploadDir: INCOMING_DIR,
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
