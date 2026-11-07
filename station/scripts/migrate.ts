import { createDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";

const db = createDb(process.env.DATABASE_URL_UNPOOLED) // direct (non-PgBouncer) URL when the host provides one;
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.end();
}
