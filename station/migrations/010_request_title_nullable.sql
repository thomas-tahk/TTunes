-- 30-day YouTube metadata rule: the daily upkeep nulls requests.title once a request is 30 days old.
alter table requests alter column title drop not null;
