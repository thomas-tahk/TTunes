import pg from "pg";

// One pool per process. Neon (prod) needs TLS: put `?sslmode=require` in DATABASE_URL.
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}
