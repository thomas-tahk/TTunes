import type pg from "pg";
import type { TrackRepo } from "../repo.ts";
import type { Track } from "../types.ts";

interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
  bitrate: number | null;
  format: string | null;
  size_bytes: string; // bigint comes back as a string
  storage_key: string;
  created_at: Date;
}

const COLUMNS =
  "id, title, artist, album, duration_sec, bitrate, format, size_bytes, storage_key, created_at";

function toTrack(r: TrackRow): Track {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    durationSec: r.duration_sec,
    bitrate: r.bitrate,
    format: r.format,
    sizeBytes: Number(r.size_bytes),
    storageKey: r.storage_key,
    createdAt: r.created_at.toISOString(),
  };
}

/** Postgres-backed catalog. Expects migrate() to have run. */
export class PgTrackRepo implements TrackRepo {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async all(): Promise<Track[]> {
    const { rows } = await this.pool.query<TrackRow>(`SELECT ${COLUMNS} FROM tracks ORDER BY seq`);
    return rows.map(toTrack);
  }

  async get(id: string): Promise<Track | undefined> {
    const { rows } = await this.pool.query<TrackRow>(`SELECT ${COLUMNS} FROM tracks WHERE id = $1`, [id]);
    return rows[0] ? toTrack(rows[0]) : undefined;
  }

  async add(t: Track): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracks (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [t.id, t.title, t.artist, t.album, t.durationSec, t.bitrate, t.format, t.sizeBytes, t.storageKey, t.createdAt],
    );
  }

  async remove(id: string): Promise<Track | undefined> {
    const { rows } = await this.pool.query<TrackRow>(
      `DELETE FROM tracks WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    return rows[0] ? toTrack(rows[0]) : undefined;
  }
}
