import { JsonTrackRepo, type TrackRepo } from "../repo.ts";
import { migrate } from "./migrate.ts";
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
