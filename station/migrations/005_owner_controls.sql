-- Trash: a trashed song keeps its row (so undo is exact) but leaves the library and shuffle.
alter table songs add column deleted_at timestamptz;
-- Where each queue entry of a trashed song sat, as the entries (queue.id) just before and after it.
-- Undo reinserts next to a surviving neighbour instead of at a bare index. next_id null = it was last.
create table trash_queue (
  id        bigserial primary key,
  video_id  text not null references songs(video_id) on delete cascade,
  prev_id   bigint,
  next_id   bigint,
  queued_at timestamptz not null
);
