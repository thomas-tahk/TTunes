-- Every listener search is an attempt, recorded before YouTube is called and kept 7 days.
-- The hourly limit counts a listener's or network's rows; the daily budget counts all rows since Pacific midnight.
create table search_attempts (
  id          bigserial primary key,
  listener_id text not null,
  ip_hash     text not null,
  at          timestamptz not null default now()
);
create index search_attempts_at_idx on search_attempts (at);
create index search_attempts_listener_idx on search_attempts (listener_id, at);
create index search_attempts_ip_idx on search_attempts (ip_hash, at);
