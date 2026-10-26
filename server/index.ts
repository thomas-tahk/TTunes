import { createApp, parseTrustProxy } from "./app.ts";
import { LocalDiskStorage } from "./storage.ts";
import { createRepoFromEnv, createStationRepoFromEnv } from "./db/index.ts";
import { authFromEnv } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8787);
const STORAGE_DIR = "uploads"; // local adapter; swaps to R2 later (design spec §9)
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as STORAGE_DIR so put() is a rename
const DATA_FILE = "data/tracks.json"; // JSON catalog, used only when DATABASE_URL is unset
const STATION_FILE = "data/station.json"; // JSON station state, likewise

let auth;
try {
  auth = authFromEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const repo = await createRepoFromEnv(DATA_FILE); // Postgres when DATABASE_URL is set
const app = createApp({
  repo,
  station: createStationRepoFromEnv(STATION_FILE, repo), // same pool as the catalog
  storage: new LocalDiskStorage(STORAGE_DIR),
  uploadDir: INCOMING_DIR,
  auth,
  // Fly.io (or any single reverse proxy in front): set TRUST_PROXY=1, otherwise
  // every client shares the proxy's IP and one stranger can trip the login lockout.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
