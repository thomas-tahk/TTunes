-- queue.id is identity only; play order is position. "Play next" = min(position) - 1, "add to queue" = max(position) + 1.
alter table queue add column position bigint;
update queue set position = id;
alter table queue alter column position set not null;
-- Plain inserts (no position given) append, as before.
alter table queue alter column position set default nextval('queue_id_seq');
