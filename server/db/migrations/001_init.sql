-- 001_init: catalog (tracks) + station state (design spec §4, §9).
-- Plain Postgres only: no extensions, no vendor features.
--
-- Rollback (manual; the runner only goes forward):
--   DROP TABLE station_queue; DROP TABLE station; DROP TABLE tracks;
--   DELETE FROM schema_migrations WHERE name = '001_init.sql';
-- Dropping tracks destroys the catalog; audio objects in storage are untouched.

-- Catalog. Columns mirror the Track type in server/types.ts.
CREATE TABLE tracks (
  -- Insertion order. all() orders by this so it matches JsonTrackRepo (array order),
  -- including tracks that share the same created_at millisecond.
  seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id           text PRIMARY KEY,              -- nanoid
  title        text NOT NULL,
  artist       text NOT NULL,
  album        text,
  duration_sec integer CHECK (duration_sec >= 0),
  bitrate      integer CHECK (bitrate >= 0),  -- bits/sec, for the quality badge
  format       text,                          -- e.g. 'MP3', 'FLAC'
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key  text NOT NULL UNIQUE,          -- opaque key into the StorageAdapter
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Station state (spec §4), for issue #7. Schema only; no repo code yet.
--
-- station: exactly one row (id is always true).
--   active_pool             what the station shuffles. jsonb so #7 can add smart
--                           filters / playlists without a migration. Default is the
--                           whole library: {"kind": "library"}.
--   now_playing_track_id    current track, or NULL when nothing is playing. Deleting
--                           the track clears it (ON DELETE SET NULL).
--   now_playing_offset_sec  playback position (seconds, fractional) as last reported.
--   now_playing_reported_at when that offset was reported; resume position is
--                           offset + (now() - reported_at) while playing.
CREATE TABLE station (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_pool             jsonb NOT NULL DEFAULT '{"kind": "library"}'::jsonb,
  now_playing_track_id    text REFERENCES tracks (id) ON DELETE SET NULL,
  now_playing_offset_sec  double precision NOT NULL DEFAULT 0 CHECK (now_playing_offset_sec >= 0),
  now_playing_reported_at timestamptz
);
INSERT INTO station DEFAULT VALUES;

-- station_queue: the manual "play next" queue, at most 6 entries (positions 0..5,
--   0 plays first). The same track may be queued twice. Deleting a track removes its
--   queue entries (ON DELETE CASCADE); #7 should compact positions after that.
CREATE TABLE station_queue (
  position integer PRIMARY KEY CHECK (position >= 0 AND position < 6),
  track_id text NOT NULL REFERENCES tracks (id) ON DELETE CASCADE
);
CREATE INDEX station_queue_track_id_idx ON station_queue (track_id);
