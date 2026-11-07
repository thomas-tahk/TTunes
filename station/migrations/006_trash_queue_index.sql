-- Where in the queue the entry sat when trashed; the last-resort undo position when both neighbours are gone.
alter table trash_queue add column queue_index integer;
