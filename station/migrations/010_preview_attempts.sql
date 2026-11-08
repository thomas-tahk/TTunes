-- Every listener link preview is an attempt (one YouTube lookup), recorded before YouTube is called and kept 7 days.
-- Its hourly limit is separate from the 5-requests-an-hour allowance; the lookups also count toward the shared daily cap.
create table preview_attempts (
  id          bigserial primary key,
  listener_id text not null,
  ip_hash     text not null,
  at          timestamptz not null default now()
);
create index preview_attempts_at_idx on preview_attempts (at);
create index preview_attempts_listener_idx on preview_attempts (listener_id, at);
create index preview_attempts_ip_idx on preview_attempts (ip_hash, at);
