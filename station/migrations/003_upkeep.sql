-- YouTube allows caching API metadata for 30 days; the daily upkeep job refreshes at 25.
alter table songs add column metadata_refreshed_at timestamptz not null default now();
create table activity_log (
  id      bigserial primary key,
  who     text not null,
  what    text not null,
  at      timestamptz not null default now(),
  details jsonb not null default '{}'
);
create table library_exports (
  id          bigserial primary key,
  exported_at timestamptz not null default now(),
  data        jsonb not null
);
