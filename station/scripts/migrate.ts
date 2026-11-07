import { createDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";

const db = createDb();
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.end();
}
