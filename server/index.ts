import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp, parseTrustProxy } from "./app.ts";
import { createStorageFromEnv, verifyStorage } from "./s3-storage.ts";
import type { StorageAdapter } from "./storage.ts";
import { createRepoFromEnv, createStationRepoFromEnv } from "./db/index.ts";
import { authFromEnv } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8787);
const INCOMING_DIR = "uploads/.incoming"; // multer scratch; same volume as local storage (uploads/) so put() is a rename
const DATA_FILE = "data/tracks.json"; // JSON catalog, used only when DATABASE_URL is unset
const STATION_FILE = "data/station.json"; // JSON station state, likewise
// Built front end: STATIC_DIR if set, else the repo's dist/ when `vite build` has run.
const BUILT_DIST = resolve(import.meta.dirname, "../dist");
const STATIC_DIR = process.env.STATIC_DIR
  ? resolve(process.env.STATIC_DIR)
  : existsSync(join(BUILT_DIST, "index.html"))
    ? BUILT_DIST
    : undefined;

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

const repo = await createRepoFromEnv(DATA_FILE); // Postgres when DATABASE_URL is set
const app = createApp({
  repo,
  station: createStationRepoFromEnv(STATION_FILE, repo), // same pool as the catalog
  storage,
  uploadDir: INCOMING_DIR,
  auth,
  // Fly.io (or any single reverse proxy in front): set TRUST_PROXY=1, otherwise
  // every client shares the proxy's IP and one stranger can trip the login lockout.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  staticDir: STATIC_DIR,
});

const server = app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}${STATIC_DIR ? ` (serving ${STATIC_DIR})` : " (API only)"}`);
});

// As a container's PID 1, node gets no default SIGTERM/SIGINT handling, so `docker stop`
// and Fly deploys would wait out the kill timeout. Stop accepting, give streams 5s, exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
