import express, { type Express } from "express";
import type { LocalDiskStorage } from "./storage.ts";
import type { TrackRepo } from "./repo.ts";
import type { YouTubeIngest } from "./ingest.ts";
import type { YtSearchRunner } from "./search.ts";
import { registerTrackRoutes } from "./routes/tracks.ts";
import { registerAudioRoutes } from "./routes/audio.ts";
import { registerIngestRoutes } from "./routes/ingest.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerStaticRoutes } from "./routes/static.ts";

export interface AppDeps {
  storage: LocalDiskStorage;
  repo: TrackRepo;
  ingest: YouTubeIngest;
  search: YtSearchRunner;
  uploadDir: string;
  staticDir?: string; // built UI (dist/); when set, the same server serves it
}

// Builds the HTTP app from its collaborators so tests can inject temp dirs and a
// fake yt-dlp runner; server/index.ts wires the real ones and listens.
// No CORS on purpose: the UI is same-origin, so foreign sites must not reach the API.
export function createApp({ storage, repo, ingest, search, uploadDir, staticDir }: AppDeps): Express {
  const app = express();
  app.use(express.json());
  registerTrackRoutes(app, { storage, repo, uploadDir });
  registerAudioRoutes(app, storage, repo);
  registerIngestRoutes(app, { storage, repo, ingest });
  registerSearchRoutes(app, search);
  if (staticDir) registerStaticRoutes(app, staticDir);
  return app;
}
