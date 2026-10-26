import { JsonTrackRepo, type TrackRepo } from "../repo.ts";
import { JsonStationRepo, type StationRepo } from "../station-repo.ts";
import { migrate } from "./migrate.ts";
import { PgStationRepo } from "./pg-station-repo.ts";
import { PgTrackRepo } from "./pg-track-repo.ts";
import { createPool } from "./pool.ts";

/** DATABASE_URL set: Postgres (pending migrations applied first). Otherwise the local JSON file. */
export async function createRepoFromEnv(jsonFile: string, env = process.env): Promise<TrackRepo> {
  if (!env.DATABASE_URL) return new JsonTrackRepo(jsonFile);
  const pool = createPool(env.DATABASE_URL);
  const applied = await migrate(pool);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
  return new PgTrackRepo(pool);
}

/**
 * Station store matching the catalog: with DATABASE_URL, Postgres on the catalog's own
 * pool (so call createRepoFromEnv first and pass its result); otherwise the JSON file.
 */
export function createStationRepoFromEnv(jsonFile: string, tracks: TrackRepo, env = process.env): StationRepo {
  if (!env.DATABASE_URL) return new JsonStationRepo(jsonFile);
  if (!(tracks instanceof PgTrackRepo)) {
    throw new Error("DATABASE_URL is set but the track repo isn't Postgres; pass createRepoFromEnv's result");
  }
  return new PgStationRepo(tracks.pool);
}
