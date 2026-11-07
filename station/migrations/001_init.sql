create table songs (
  video_id     text primary key,
  title        text not null,
  duration_sec integer not null check (duration_sec > 0),
  added_at     timestamptz not null default now()
);
create table queue (
  id        bigserial primary key,
  video_id  text not null references songs(video_id) on delete cascade,
  queued_at timestamptz not null default now()
);
create table station_state (
  id               integer primary key check (id = 1),
  current_video_id text,
  started_at_ms    bigint,
  cycle            jsonb not null default '{"unplayed":[],"played":[]}'
);
create table play_history (
  id            bigserial primary key,
  video_id      text not null,
  started_at_ms bigint not null
);
