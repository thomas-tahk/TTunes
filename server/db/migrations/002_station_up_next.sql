-- 002_station_up_next: the station's pre-drawn shuffle pick (issue #7), so a device can
-- prefetch the next track before the current one ends (spec §5 "no inter-track buffer").
--
-- up_next_track_id  the track the station plays next once the manual queue is empty.
--                   NULL = not drawn yet; the server draws one on its next read. Deleting
--                   the track clears it (ON DELETE SET NULL) and the server redraws.
--
-- Rollback (manual; the runner only goes forward):
--   ALTER TABLE station DROP COLUMN up_next_track_id;
--   DELETE FROM schema_migrations WHERE name = '002_station_up_next.sql';
ALTER TABLE station
  ADD COLUMN up_next_track_id text REFERENCES tracks (id) ON DELETE SET NULL;
