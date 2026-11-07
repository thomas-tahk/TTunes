import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LOCK_KEY = 727001; // advisory lock so two runners never apply the same file twice

/** Applies numbered .sql files in order, once each, recording them in schema_migrations. Returns the names applied. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files.filter((f) => !done.has(f))) {
      await applyOne(client, file, readFileSync(`${dir}/${file}`, "utf8"));
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function applyOne(client: { query: Db["query"] }, name: string, sql: string): Promise<void> {
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations (name) values ($1)", [name]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw new Error(`migration ${name} failed: ${(error as Error).message}`);
  }
}
