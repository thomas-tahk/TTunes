import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { migrate } from "../db/migrate.ts";
import { PgTrackRepo } from "../db/pg-track-repo.ts";
import { createPool } from "../db/pool.ts";
import { createRepoFromEnv } from "../db/index.ts";
import type { Track } from "../types.ts";
import { trackRepoContract } from "./track-repo.contract.ts";

// Runs only when TEST_DATABASE_URL points at a throwaway Postgres. It DROPS every
// table in that database's public schema first — never point it at real data.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });
  afterAll(async () => {
    await pool?.end();
  });

  describe("migrate", () => {
    it("applies 001 to an empty database, then is a no-op", async () => {
      expect(await migrate(pool)).toEqual(["001_init.sql"]);
      expect(await migrate(pool)).toEqual([]);
      const { rows } = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.map((r) => r.name)).toEqual(["001_init.sql"]);
    });

    it("is safe when two boots race", async () => {
      expect(await Promise.all([migrate(pool), migrate(pool)])).toEqual([[], []]);
    });

    it("rolls back a failing migration completely", async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "ttunes-mig-"));
      writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE should_not_exist (x int);");
      writeFileSync(join(dir, "002_bad.sql"), "SELECT * FROM no_such_table;");
      try {
        await expect(migrate(pool, dir)).rejects.toThrow(/no_such_table/);
        const { rows } = await pool.query("SELECT to_regclass('should_not_exist') AS t");
        expect(rows[0].t).toBeNull();
        const names = await pool.query("SELECT name FROM schema_migrations");
        expect(names.rows.map((r) => r.name)).toEqual(["001_init.sql"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Each contract test gets an empty catalog. Deleting tracks also clears station refs.
  trackRepoContract("PgTrackRepo", async () => {
    await migrate(pool);
    await pool.query("DELETE FROM tracks");
    return new PgTrackRepo(pool);
  });

  describe("PgTrackRepo extras", () => {
    const t: Track = {
      id: "dup",
      title: "T",
      artist: "A",
      album: null,
      durationSec: null,
      bitrate: null,
      format: null,
      sizeBytes: 1,
      storageKey: "dup.mp3",
      createdAt: new Date(0).toISOString(),
    };

    it("rejects a duplicate id", async () => {
      await pool.query("DELETE FROM tracks");
      const repo = new PgTrackRepo(pool);
      await repo.add(t);
      await expect(repo.add({ ...t, storageKey: "other.mp3" })).rejects.toThrow(/duplicate key/);
    });

    it("createRepoFromEnv picks Postgres when DATABASE_URL is set", async () => {
      const repo = await createRepoFromEnv("unused.json", { DATABASE_URL: url });
      expect(repo).toBeInstanceOf(PgTrackRepo);
      await (repo as unknown as { pool: pg.Pool }).pool.end();
    });
  });

  describe("station schema (for #7)", () => {
    const add = (id: string) =>
      pool.query(
        "INSERT INTO tracks (id, title, artist, size_bytes, storage_key) VALUES ($1, 'T', 'A', 1, $1)",
        [id],
      );

    it("has exactly one station row defaulting to the whole library", async () => {
      const { rows } = await pool.query("SELECT * FROM station");
      expect(rows).toHaveLength(1);
      expect(rows[0].active_pool).toEqual({ kind: "library" });
      expect(rows[0].now_playing_track_id).toBeNull();
      await expect(pool.query("INSERT INTO station (id) VALUES (false)")).rejects.toThrow();
      await expect(pool.query("INSERT INTO station DEFAULT VALUES")).rejects.toThrow(/duplicate key/);
    });

    it("deleting a track clears now_playing and drops its queue entries", async () => {
      await pool.query("DELETE FROM tracks");
      await add("np");
      await add("keep");
      await pool.query(
        "UPDATE station SET now_playing_track_id = 'np', now_playing_offset_sec = 12.5, now_playing_reported_at = now()",
      );
      await pool.query("INSERT INTO station_queue (position, track_id) VALUES (0, 'np'), (1, 'keep'), (2, 'np')");
      await new PgTrackRepo(pool).remove("np");
      const st = await pool.query("SELECT now_playing_track_id FROM station");
      expect(st.rows[0].now_playing_track_id).toBeNull();
      const q = await pool.query("SELECT position, track_id FROM station_queue ORDER BY position");
      expect(q.rows).toEqual([{ position: 1, track_id: "keep" }]);
    });

    it("caps the queue at positions 0..5 and rejects unknown tracks", async () => {
      await pool.query("DELETE FROM tracks");
      await add("q");
      await pool.query("INSERT INTO station_queue (position, track_id) VALUES (5, 'q')");
      await expect(pool.query("INSERT INTO station_queue (position, track_id) VALUES (6, 'q')")).rejects.toThrow(
        /check constraint/,
      );
      await expect(
        pool.query("INSERT INTO station_queue (position, track_id) VALUES (0, 'ghost')"),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
