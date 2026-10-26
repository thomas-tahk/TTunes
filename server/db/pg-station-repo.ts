import type pg from "pg";
import { StationConflictError, type ActivePool, type StationRepo, type StationState } from "../station-repo.ts";

interface StationRow {
  active_pool: ActivePool;
  now_playing_track_id: string | null;
  now_playing_offset_sec: number;
  now_playing_reported_at: Date | null;
  now_playing_playing: boolean;
  up_next_track_id: string | null;
}

const SELECT_STATION = `SELECT active_pool, now_playing_track_id, now_playing_offset_sec,
  now_playing_reported_at, now_playing_playing, up_next_track_id FROM station`;

const FOREIGN_KEY_VIOLATION = "23503";

async function load(db: pg.PoolClient, forUpdate: boolean): Promise<StationState> {
  const st = await db.query<StationRow>(`${SELECT_STATION}${forUpdate ? " FOR UPDATE" : ""}`);
  const row = st.rows[0];
  if (!row) throw new Error("station row missing (migration 001 inserts it)");
  // ORDER BY position, read as an array: gaps left by ON DELETE CASCADE vanish here
  // and are closed for good on the next queue write, which renumbers 0..n-1.
  const q = await db.query<{ track_id: string }>("SELECT track_id FROM station_queue ORDER BY position");
  return {
    activePool: row.active_pool,
    // 001: offset/reported_at/playing are meaningless once the track id is NULL.
    nowPlaying: row.now_playing_track_id
      ? {
          trackId: row.now_playing_track_id,
          offsetSec: row.now_playing_offset_sec,
          reportedAt: (row.now_playing_reported_at ?? new Date()).toISOString(),
          playing: row.now_playing_playing,
        }
      : null,
    queue: q.rows.map((r) => r.track_id),
    upNext: row.up_next_track_id,
  };
}

const sameQueue = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Postgres-backed station (tables from 001_init + 002). Expects migrate() to have run. */
export class PgStationRepo implements StationRepo {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async get(): Promise<StationState> {
    // One snapshot, so the station row and the queue agree with each other.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const s = await load(client, false);
      await client.query("COMMIT");
      client.release();
      return s;
    } catch (err) {
      await this.abort(client, err);
      throw err;
    }
  }

  async update(fn: (current: StationState) => StationState | null): Promise<StationState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Row lock on the singleton serialises every station write across processes.
      const current = await load(client, true);
      const next = fn(structuredClone(current));
      if (next) {
        const np = next.nowPlaying;
        await client.query(
          `UPDATE station SET active_pool = $1, now_playing_track_id = $2, now_playing_offset_sec = $3,
             now_playing_reported_at = $4, now_playing_playing = $5, up_next_track_id = $6`,
          [
            JSON.stringify(next.activePool),
            np?.trackId ?? null,
            np?.offsetSec ?? 0,
            np?.reportedAt ?? null,
            np?.playing ?? false,
            next.upNext,
          ],
        );
        if (!sameQueue(current.queue, next.queue)) {
          await client.query("DELETE FROM station_queue");
          if (next.queue.length) {
            await client.query(
              `INSERT INTO station_queue (position, track_id)
               SELECT ord - 1, id FROM unnest($1::text[]) WITH ORDINALITY AS q(id, ord)`,
              [next.queue],
            );
          }
        }
      }
      await client.query("COMMIT");
      client.release();
      return next ?? current;
    } catch (err) {
      await this.abort(client, err);
      if ((err as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) throw new StationConflictError(err);
      throw err;
    }
  }

  private async abort(client: pg.PoolClient, err: unknown): Promise<void> {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      // Connection is likely broken: destroy it rather than return it to the pool.
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
