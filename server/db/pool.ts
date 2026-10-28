import pg from "pg";

/** How long to wait for a connection before failing; without it an unreachable host hangs forever. */
const CONNECT_TIMEOUT_MS = 10_000;

// One pool per process. Neon (prod) needs TLS: put `?sslmode=verify-full` in DATABASE_URL
// (encrypts and checks the server certificate; `require` only encrypts).
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // An idle client dropped server-side (Neon compute suspend/restart, pg_terminate_backend)
  // emits 'error' on the pool; unhandled, that kills the process. The pool discards the
  // dead client and opens a new one on the next query, so logging is enough.
  pool.on("error", (err) => {
    console.error("postgres: idle client error (discarded):", err.message);
  });
  return pool;
}

/**
 * One-line, password-free description of a connection/migration error, for the startup log.
 * pg's own messages don't carry the URL, but redact it anyway in case one ever does.
 */
export function dbErrorMessage(err: unknown, connectionString: string): string {
  const e = err as { message?: string; code?: string; errors?: unknown[] };
  let msg = e?.message || "";
  // Node's dual-stack connect failure is an AggregateError with an empty message
  if (!msg && Array.isArray(e?.errors)) msg = e.errors.map((x) => (x as Error)?.message).filter(Boolean).join("; ");
  if (!msg) msg = e?.code || String(err);
  msg = msg.replace(/\s+/g, " ").trim();
  // user:password@ in any URL
  msg = msg.replace(/(\w+:\/\/[^\s:/@]*:)[^\s@]*@/g, "$1***@");
  let password = "";
  try {
    password = new URL(connectionString).password;
  } catch {
    // unparsable URL: the regex above is all we can do
  }
  // A bare password in the text too, unless it's so short it would mangle ordinary words
  // (local dev's "ttunes" would turn database "ttunes_x" into "***_x").
  for (const p of new Set([password, safeDecode(password)])) {
    if (p.length >= 8) msg = msg.split(p).join("***");
  }
  return msg;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
