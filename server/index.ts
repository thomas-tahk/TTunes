import { createApp } from "./app.ts";
import { createStorageFromEnv } from "./s3-storage.ts";
import { JsonTrackRepo } from "./repo.ts";

const PORT = Number(process.env.PORT ?? 8787);
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as local storage (uploads/) so put() is a rename
const DATA_FILE = "data/tracks.json"; // local adapter; swaps to Postgres later

const app = createApp({
  repo: new JsonTrackRepo(DATA_FILE),
  storage: createStorageFromEnv(), // S3/R2 when S3_BUCKET is set, else local uploads/
  uploadDir: INCOMING_DIR,
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
