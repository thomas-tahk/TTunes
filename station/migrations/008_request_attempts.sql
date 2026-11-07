-- Every listener post that reaches YouTube is an attempt, kept 7 days. Refused lookups (unknown id, blocked, too long) insert no request,
-- so the 5/hour limit and the global daily lookup cap count these rows instead.
create table request_attempts (
  id          bigserial primary key,
  listener_id text not null,
  ip_hash     text not null,
  at          timestamptz not null default now()
);
create index request_attempts_at_idx on request_attempts (at);
create index request_attempts_listener_idx on request_attempts (listener_id, at);
create index request_attempts_ip_idx on request_attempts (ip_hash, at);
