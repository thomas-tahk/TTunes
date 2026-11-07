import pg from "pg";

// Same client for local Docker Postgres and Neon: only DATABASE_URL differs.
const LOCAL_URL = "postgres://ttunes:ttunes@localhost:55432/ttunes_station";

export type Db = pg.Pool;

export function connectionString(env: NodeJS.ProcessEnv = process.env): string {
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

export const SCHEMA = `
create table if not exists songs (
  video_id     text primary key,
  title        text not null,
  duration_sec integer not null check (duration_sec > 0),
  added_at     timestamptz not null default now()
);
create table if not exists queue (
  id        bigserial primary key,
  video_id  text not null references songs(video_id) on delete cascade,
  queued_at timestamptz not null default now()
);
create table if not exists station_state (
  id               integer primary key check (id = 1),
  current_video_id text,
  started_at_ms    bigint,
  cycle            jsonb not null default '{"unplayed":[],"played":[]}'
);
create table if not exists play_history (
  id            bigserial primary key,
  video_id      text not null,
  started_at_ms bigint not null
);
`;

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA);
}
