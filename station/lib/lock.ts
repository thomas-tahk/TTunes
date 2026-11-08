import type pg from "pg";

/**
 * The one lock every station writer takes FIRST (advance, skip, adds, owner edits, upkeep removals and purges).
 * One global order means two writers can wait on each other but never deadlock.
 */
export async function lockStation(client: pg.ClientBase): Promise<void> {
  await client.query("insert into station_state (id) values (1) on conflict do nothing");
  await client.query("select 1 from station_state where id = 1 for update");
}
