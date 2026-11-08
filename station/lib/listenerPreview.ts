import type pg from "pg";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import { DAILY_LOOKUP_CAP, getMode, type Refusal, type Who } from "./requests.ts";
import type { Clock } from "./schedule.ts";

export const MAX_PREVIEWS_PER_DAY = 1000; // station-wide, so preview spam cannot use up the 2000 lookups that requests share
export const MAX_PREVIEWS_PER_HOUR = 30; // a preview is one cheap lookup; the 5/hour request allowance is untouched

const refuse = (status: number, code: string, message: string): Refusal => ({ ok: false, status, code, message });
const at = (ms: number): Date => new Date(ms);

async function check(q: Pick<pg.ClientBase, "query">, who: Who, now: number): Promise<Refusal | null> {
  if ((await getMode(q)) === "off") return refuse(403, "off", "Requests are turned off right now.");
  const hourly = await q.query("select count(*) filter (where listener_id = $1)::int as mine, count(*)::int as n from preview_attempts where at > $3 and (listener_id = $1 or ip_hash = $2)", [who.listenerId, who.ipHash, at(now - 3600_000)]);
  if (hourly.rows[0].n >= MAX_PREVIEWS_PER_HOUR) {
    const from = hourly.rows[0].mine >= MAX_PREVIEWS_PER_HOUR ? "" : " from your network"; // same wording as post requests
    return refuse(429, "rate_limited", `That's a lot of link checks this hour${from}. Try again later.`);
  }
  const since = at(now - 24 * 3600_000);
  const previews = await q.query("select count(*)::int as n from preview_attempts where at > $1", [since]);
  if (previews.rows[0].n >= MAX_PREVIEWS_PER_DAY) return refuse(503, "paused", "Link checks are paused for today. Try again tomorrow.");
  const daily = await q.query("select (select count(*) from request_attempts where at > $1) + (select count(*) from preview_attempts where at > $1) as n", [since]);
  if (Number(daily.rows[0].n) >= DAILY_LOOKUP_CAP) return refuse(503, "paused", "Requests are paused for today. Try again tomorrow.");
  return null;
}

/** Under the station lock: mode, hourly preview limit per listener or network, shared daily lookup cap; records the attempt BEFORE YouTube is called. */
export async function reservePreview(db: Db, who: Who, clock: Clock): Promise<Refusal | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = clock();
    const refusal = await check(client, who, now);
    if (!refusal) await client.query("insert into preview_attempts (listener_id, ip_hash, at) values ($1, $2, $3)", [who.listenerId, who.ipHash, at(now)]);
    await client.query("commit");
    return refusal;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
