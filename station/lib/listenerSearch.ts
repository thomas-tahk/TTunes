import type pg from "pg";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import { MAX_PER_HOUR, getMode, type Refusal, type Who } from "./requests.ts";
import type { Clock } from "./schedule.ts";

export const LISTENER_DAILY_SEARCHES = 60; // of YouTube's 100 search.list calls a day; the other 40 are the owner's
export const SEARCH_PAUSED_MESSAGE = "Search is resting for today — paste a YouTube link instead.";

const refuse = (status: number, code: string, message: string): Refusal => ({ ok: false, status, code, message });
const at = (ms: number): Date => new Date(ms);

const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

/** Pacific wall clock minus UTC at an instant, in ms (negative in the US). */
function pacificOffset(ms: number): number {
  const parts = pacific.formatToParts(at(ms));
  const v = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - Math.floor(ms / 1000) * 1000;
}

/** Start of the current Pacific calendar day (YouTube's quota resets at midnight Pacific), as epoch ms. Re-reads the offset at midnight so DST days are right. */
export function pacificDayStart(now: number): number {
  const wall = new Date(now + pacificOffset(now));
  const wallMidnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return wallMidnight - pacificOffset(wallMidnight - pacificOffset(now));
}

async function check(q: Pick<pg.ClientBase, "query">, who: Who, now: number): Promise<Refusal | null> {
  if ((await getMode(q)) === "off") return refuse(403, "off", "Requests are turned off right now.");
  const hourly = await q.query("select count(*) filter (where listener_id = $1)::int as mine, count(*)::int as n from search_attempts where at > $3 and (listener_id = $1 or ip_hash = $2)", [who.listenerId, who.ipHash, at(now - 3600_000)]);
  if (hourly.rows[0].n >= MAX_PER_HOUR) {
    const from = hourly.rows[0].mine >= MAX_PER_HOUR ? "" : " from your network"; // same wording as post requests
    return refuse(429, "rate_limited", `That's ${MAX_PER_HOUR} searches this hour${from}. Try again later.`);
  }
  const daily = await q.query("select count(*)::int as n from search_attempts where at >= $1", [at(pacificDayStart(now))]);
  if (daily.rows[0].n >= LISTENER_DAILY_SEARCHES) return refuse(503, "search_paused", SEARCH_PAUSED_MESSAGE);
  return null;
}

/** Under the station lock: mode, then 5/hour per listener or network, then the global daily budget; records the attempt BEFORE YouTube is called. */
export async function reserveSearch(db: Db, who: Who, clock: Clock): Promise<Refusal | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = clock();
    const refusal = await check(client, who, now);
    if (!refusal) await client.query("insert into search_attempts (listener_id, ip_hash, at) values ($1, $2, $3)", [who.listenerId, who.ipHash, at(now)]);
    await client.query("commit");
    return refusal;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
