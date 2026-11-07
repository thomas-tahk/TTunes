import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../lib/auth.ts";
import { sharedDb } from "../../lib/db.ts";
import { purgeTrash, refreshStale, storeExport } from "../../lib/upkeep.ts";

// Vercel sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations. No secret configured = nobody gets in.
function authorized(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.authorization ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// GET /api/cron/refresh (daily): refresh stale song metadata, then store the dated library export.
// The backup runs even if the refresh failed; any failure still ends in a 500 so the cron log shows it.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  const db = sharedDb();
  const failures: string[] = [];
  let refresh;
  let exportedSongs;
  try {
    refresh = await refreshStale(db);
  } catch (error) {
    console.error("cron refresh failed", error);
    failures.push("refresh");
  }
  try {
    exportedSongs = await storeExport(db);
  } catch (error) {
    console.error("cron export failed", error);
    failures.push("export");
  }
  let purged;
  try {
    purged = await purgeTrash(db);
  } catch (error) {
    console.error("cron trash purge failed", error);
    failures.push("purge");
  }
  sendJson(res, failures.length ? 500 : 200, { ok: failures.length === 0, failures, refresh, exportedSongs, purged });
}
