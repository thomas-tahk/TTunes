import type pg from "pg";
import { LONG_SEC, lookupVideo, thumbnailOf } from "./addSong.ts";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import type { Clock } from "./schedule.ts";

export type Mode = "open" | "approve" | "off";
export const MODES: readonly Mode[] = ["open", "approve", "off"];
export const MUSIC_CATEGORY = "10";
export const AUTO_MAX_SEC = 10 * 60; // Music under 10 minutes plays without the owner
export const MAX_PER_HOUR = 5;
export const WAIT_EXPIRY_MS = 24 * 3600 * 1000;
export const IP_KEEP_MS = 7 * 24 * 3600 * 1000;
export const DAILY_LOOKUP_CAP = 2000; // listener-triggered YouTube lookups per rolling 24h, 1 quota unit each; protects the owner's 10,000-unit pool
export const NAME_MAX = 30;
export const DEDICATION_MAX = 140;

type Queryable = Pick<pg.ClientBase, "query">;
export type Refusal = { ok: false; status: number; code: string; message: string };
const refuse = (status: number, code: string, message: string): Refusal => ({ ok: false, status, code, message });

export interface RequestInput {
  videoId: string;
  name: string;
  dedication: string;
}
export interface Who {
  listenerId: string;
  ipHash: string;
}
export interface PostedRequest {
  id: number;
  status: "waiting" | "queued";
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  name: string;
  dedication: string;
}
export type PostResult = { ok: true; request: PostedRequest } | Refusal;

// Control (Cc, incl. C1 and newlines), format (Cf: zero-width, RTL override) and the Unicode line/paragraph separators.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const VISIBLE_CHAR = /[^\p{Z}\p{C}]/u;
const length = (text: string): number => [...text].length;

/** Name 1-30 and dedication 0-140 characters of plain text (no control characters), trimmed. Null body fields are rejected, unknown fields ignored by the caller. */
export function validateText(name: unknown, dedication: unknown): { ok: true; name: string; dedication: string } | Refusal {
  if (typeof name !== "string" || (dedication !== undefined && dedication !== null && typeof dedication !== "string")) return refuse(400, "bad_input", "Name and dedication must be text.");
  const cleanName = name.trim();
  const cleanDedication = (dedication ?? "").trim();
  if (length(cleanName) < 1 || length(cleanName) > NAME_MAX) return refuse(400, "bad_name", `Name must be 1 to ${NAME_MAX} characters.`);
  if (length(cleanDedication) > DEDICATION_MAX) return refuse(400, "bad_dedication", `Dedication can be up to ${DEDICATION_MAX} characters.`);
  if (HIDDEN_CHARS.test(cleanName) || HIDDEN_CHARS.test(cleanDedication)) return refuse(400, "bad_text", "Name and dedication must be plain text.");
  if (!VISIBLE_CHAR.test(cleanName)) return refuse(400, "bad_name", "Name needs at least one visible character.");
  return { ok: true, name: cleanName, dedication: cleanDedication };
}

export async function getMode(q: Queryable): Promise<Mode> {
  const { rows } = await q.query("select value from settings where key = 'request_mode'");
  const value = rows[0]?.value;
  return MODES.includes(value) ? value : "open";
}

const at = (ms: number): Date => new Date(ms);

/** Waiting requests older than 24h become expired. Callers hold the station lock. */
async function expireWaiting(q: Queryable, now: number): Promise<number> {
  const { rowCount } = await q.query("update requests set status = 'expired', decided_at = $1 where status = 'waiting' and created_at <= $2", [at(now), at(now - WAIT_EXPIRY_MS)]);
  return rowCount ?? 0;
}

/** Takes the station lock, then expires stale waiting requests. For the feed and upkeep. */
export async function expireStale(db: Db, clock: Clock): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const count = await expireWaiting(client, clock());
    await client.query("commit");
    return count;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The state rules (not rates): mode, one active request per listener, song already coming up. */
async function checkRules(q: Queryable, who: Who, videoId: string, now: number): Promise<Refusal | null> {
  if ((await getMode(q)) === "off") return refuse(403, "off", "Requests are turned off right now.");
  const cutoff = at(now - WAIT_EXPIRY_MS); // a waiting request past 24h is as good as expired even before it is marked so
  const active = await q.query(`select 1 from requests where (status = 'queued' or (status = 'waiting' and created_at > $3)) and (listener_id = $1 or ip_hash = $2) limit 1`, [who.listenerId, who.ipHash, cutoff]);
  if (active.rowCount) return refuse(409, "active_request", "You already have a request waiting or lined up. Wait for it to play.");
  if (await alreadyComingUp(q, videoId, cutoff)) return refuse(409, "already_coming_up", "That song is already coming up.");
  return null;
}

/** The rate rules, on attempts (every post that reached YouTube, accepted or not): 5/hour per listener or IP, and a global daily cap. */
async function checkRates(q: Queryable, who: Who, now: number): Promise<Refusal | null> {
  const hourly = await q.query("select count(*)::int as n from request_attempts where at > $3 and (listener_id = $1 or ip_hash = $2)", [who.listenerId, who.ipHash, at(now - 3600_000)]);
  if (hourly.rows[0].n >= MAX_PER_HOUR) return refuse(429, "rate_limited", `That's ${MAX_PER_HOUR} requests this hour. Try again later.`);
  const daily = await q.query("select count(*)::int as n from request_attempts where at > $1", [at(now - 24 * 3600_000)]);
  if (daily.rows[0].n >= DAILY_LOOKUP_CAP) return refuse(503, "paused", "Requests are paused for today. Try again tomorrow.");
  return null;
}

/** Under the station lock: state and rate rules, then record the attempt BEFORE YouTube is called, so refused lookups still count. */
async function reserveAttempt(db: Db, who: Who, videoId: string, clock: Clock): Promise<Refusal | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = clock();
    const refusal = (await checkRules(client, who, videoId, now)) ?? (await checkRates(client, who, now));
    if (!refusal) await client.query("insert into request_attempts (listener_id, ip_hash, at) values ($1, $2, $3)", [who.listenerId, who.ipHash, at(now)]);
    await client.query("commit");
    return refusal;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function alreadyComingUp(q: Queryable, videoId: string, cutoff: Date): Promise<boolean> {
  const { rowCount } = await q.query(
    `select 1 from station_state where current_video_id = $1
     union all select 1 from queue where video_id = $1
     union all select 1 from requests where video_id = $1 and (status in ('queued', 'playing') or (status = 'waiting' and created_at > $2))`,
    [videoId, cutoff],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * A listener's request. Rules run once before YouTube (so refusals cost no quota) and again under the station lock
 * (so two simultaneous posts cannot both pass). Metadata is always re-fetched; the client's is never trusted.
 */
export async function postRequest(db: Db, input: RequestInput, who: Who, clock: Clock): Promise<PostResult> {
  const early = await reserveAttempt(db, who, input.videoId, clock);
  if (early) return early;
  const found = await lookupVideo(input.videoId);
  if (!found.ok) return refuse(found.status, found.status >= 500 ? "youtube_unavailable" : "video_unavailable", found.message);
  const info = found.info;
  if (info.durationSec > LONG_SEC) return refuse(422, "too_long", "That song is over 15 minutes, which is too long for requests.");
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = clock();
    await expireWaiting(client, now);
    const refusal = await checkRules(client, who, input.videoId, now); // rates were charged at reserveAttempt
    if (refusal) {
      await client.query("commit");
      return refusal;
    }
    const auto = (await getMode(client)) === "open" && info.categoryId === MUSIC_CATEGORY && info.durationSec < AUTO_MAX_SEC;
    const status = auto ? "queued" : "waiting";
    const { rows } = await client.query(
      `insert into requests (video_id, title, duration_sec, category_id, name, dedication, status, listener_id, ip_hash, created_at, queued_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [info.videoId, info.title, info.durationSec, info.categoryId, input.name, input.dedication, status, who.listenerId, who.ipHash, at(now), auto ? at(now) : null],
    );
    await client.query("commit");
    return { ok: true, request: { id: Number(rows[0].id), status, videoId: info.videoId, title: info.title, durationSec: info.durationSec, thumbnail: thumbnailOf(info.videoId), name: input.name, dedication: input.dedication } };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Daily upkeep: IP hashes older than 7 days are erased from requests (rows stay for the feed) and old attempts are deleted.
 * Takes the station lock first like every writer. Returns how many request rows were cleared. */
export async function purgeOldIpHashes(db: Db, clock: Clock): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const cutoff = at(clock() - IP_KEEP_MS);
    const { rowCount } = await client.query("update requests set ip_hash = null where ip_hash is not null and created_at <= $1", [cutoff]);
    await client.query("delete from request_attempts where at <= $1", [cutoff]);
    await client.query("commit");
    return rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// --- owner-side helpers for the moderation endpoints (#32): each runs under the station lock and writes activity_log.

export async function setMode(db: Db, mode: Mode): Promise<void> {
  if (!MODES.includes(mode)) throw new Error(`unknown request mode: ${String(mode)}`);
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    await client.query("insert into settings (key, value) values ('request_mode', $1) on conflict (key) do update set value = excluded.value", [mode]);
    await client.query("insert into activity_log (who, what, details) values ('owner', 'request_mode', $1)", [{ mode }]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type Moderation = "approve" | "deny" | "remove";
const MODERATION: Record<Moderation, { from: string; to: string }> = {
  approve: { from: "waiting", to: "queued" },
  deny: { from: "waiting", to: "denied" },
  remove: { from: "queued", to: "denied" },
};

/** approve (waiting -> queued), deny (waiting -> denied) or remove (queued -> denied). False when the request is not in the right state. */
export async function moderate(db: Db, id: number, action: Moderation, clock: Clock): Promise<boolean> {
  const rule = MODERATION[action];
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = at(clock());
    const { rows } = await client.query(
      "update requests set status = $2::text, decided_at = $3, queued_at = case when $2::text = 'queued' then $3::timestamptz else queued_at end where id = $1 and status = $4 returning video_id, title, name",
      [id, rule.to, now, rule.from],
    );
    if (rows[0]) await client.query("insert into activity_log (who, what, details) values ('owner', $1, $2)", [`request_${action}`, { id, videoId: rows[0].video_id, title: rows[0].title, name: rows[0].name }]);
    await client.query("commit");
    return rows.length === 1;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
