import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
// Arbitrary constant: serialises concurrent boots so two processes never apply the same file.
const LOCK_KEY = 4_175_005;

/**
 * Applies pending `migrations/NNN_name.sql` files in name order, all in one transaction,
 * recording each in `schema_migrations`. Idempotent; safe to run on every boot.
 * Returns the names it applied.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const { createPool } = await import("./pool.ts");
  const pool = createPool(url);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } finally {
    await pool.end();
  }
}
