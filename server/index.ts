import { createApp, parseTrustProxy } from "./app.ts";
import { createStorageFromEnv, verifyStorage } from "./s3-storage.ts";
import type { StorageAdapter } from "./storage.ts";
import { createRepoFromEnv } from "./db/index.ts";
import { authFromEnv } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8787);
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as local storage (uploads/) so put() is a rename
const DATA_FILE = "data/tracks.json"; // JSON catalog, used only when DATABASE_URL is unset

let auth;
try {
  auth = authFromEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

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
  repo: await createRepoFromEnv(DATA_FILE), // Postgres when DATABASE_URL is set
  storage,
  uploadDir: INCOMING_DIR,
  auth,
  // Fly.io (or any single reverse proxy in front): set TRUST_PROXY=1, otherwise
  // every client shares the proxy's IP and one stranger can trip the login lockout.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
