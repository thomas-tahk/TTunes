import pg from "pg";

// Same client for local Docker Postgres and Neon: only DATABASE_URL differs.
const LOCAL_URL = "postgres://ttunes:ttunes@localhost:55432/ttunes_station";

export type Db = pg.Pool;

function connectionString(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.VERCEL) throw new Error("DATABASE_URL is not set");
  return LOCAL_URL;
}

export function createDb(url: string = connectionString()): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

let shared: Db | undefined;
export function sharedDb(): Db {
  shared ??= createDb();
  return shared;
}
