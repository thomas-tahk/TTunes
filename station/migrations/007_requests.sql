-- Listener requests (M3). A request is not a library song: it keeps its own title and length.
-- Status: waiting (needs the owner) -> queued -> playing -> played; or denied / expired (24h unanswered).
create table requests (
  id           bigserial primary key,
  video_id     text not null,
  title        text not null,
  duration_sec integer not null check (duration_sec > 0),
  category_id  text not null default '',
  name         text not null,
  dedication   text not null default '',
  status       text not null check (status in ('waiting', 'queued', 'playing', 'played', 'denied', 'expired')),
  listener_id  text not null,
  ip_hash      text, -- salted hash; nulled by the daily upkeep after 7 days
  created_at   timestamptz not null default now(),
  queued_at    timestamptz, -- when it entered the play order (auto, or the owner's approval)
  decided_at   timestamptz
);
create index requests_status_idx on requests (status, queued_at, id);
create index requests_listener_idx on requests (listener_id, created_at);
create index requests_ip_idx on requests (ip_hash, created_at);

create table settings (
  key   text primary key,
  value text not null
);
insert into settings (key, value) values ('request_mode', 'open');
