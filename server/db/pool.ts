import pg from "pg";

// One pool per process. Neon (prod) needs TLS: put `?sslmode=verify-full` in DATABASE_URL
// (encrypts and checks the server certificate; `require` only encrypts).
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // An idle client dropped server-side (Neon compute suspend/restart, pg_terminate_backend)
  // emits 'error' on the pool; unhandled, that kills the process. The pool discards the
  // dead client and opens a new one on the next query, so logging is enough.
  pool.on("error", (err) => {
    console.error("postgres: idle client error (discarded):", err.message);
  });
  return pool;
}
