import type pg from "pg";
import { addToLibrary, LONG_SEC, lookupVideo, type PlayableVideo, thumbnailOf } from "./addSong.ts";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import type { Clock } from "./schedule.ts";
import { SYSTEM_ACTOR } from "./upkeep.ts";

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
export const REQUEST_KEEP_DAYS = 28; // YouTube's 30-day metadata cache rule, minus two days: the daily cron (Vercel Hobby) fires within ±59 min of its slot

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

// Spoofing characters: C0/C1 controls (newlines too), zero-width space, word joiner, BOM, line/paragraph separators, bidi overrides and isolates.
// ZWJ/ZWNJ (U+200C/D) and tag characters stay allowed: Persian names, family/rainbow/England-flag emoji.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b\u2060\ufeff\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// Something a reader can see: not whitespace, not a format/control/unassigned char, not a combining mark, not a blank-looking filler.
const VISIBLE_CHAR = /[^\p{Z}\p{C}\p{M}\u3164\u2800\u115f\u1160\uffa0]/u;
export const MAX_MARKS_PER_GRAPHEME = 4; // Burmese, pointed Hebrew and Tibetan stack up to 4; more is Zalgo
const FORMAT_CHARS = /[\p{Cf}\p{Cn}]/gu; // format + unassigned: browsers draw both with zero width
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_MARK = /\p{M}/gu;
/** Zalgo check: invisibles (ZWJ, tags, U+2061...) are stripped first so they cannot split a stack, then marks are counted per grapheme. */
function hasStackedMarks(text: string): boolean {
  for (const { segment } of graphemes.segment(text.replace(FORMAT_CHARS, ""))) {
    if ((segment.match(COMBINING_MARK)?.length ?? 0) > MAX_MARKS_PER_GRAPHEME) return true;
  }
  return false;
}
const length = (text: string): number => [...text].length;

/** Name 1-30 and dedication 0-140 characters of plain text (no control characters), trimmed. Null body fields are rejected, unknown fields ignored by the caller. */
export function validateText(name: unknown, dedication: unknown): { ok: true; name: string; dedication: string } | Refusal {
  if (typeof name !== "string" || (dedication !== undefined && dedication !== null && typeof dedication !== "string")) return refuse(400, "bad_input", "Name and dedication must be text.");
  const cleanName = name.trim();
  const cleanDedication = (dedication ?? "").trim();
  if (length(cleanName) < 1 || length(cleanName) > NAME_MAX) return refuse(400, "bad_name", `Name must be 1 to ${NAME_MAX} characters.`);
  if (length(cleanDedication) > DEDICATION_MAX) return refuse(400, "bad_dedication", `Dedication can be up to ${DEDICATION_MAX} characters.`);
  if (HIDDEN_CHARS.test(name) || HIDDEN_CHARS.test(dedication ?? "")) return refuse(400, "bad_text", "Name and dedication must be plain text."); // raw input: trim() would hide a trailing BOM or separator
  if (hasStackedMarks(cleanName) || hasStackedMarks(cleanDedication)) return refuse(400, "bad_text", "Too many stacked accent marks.");
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
  const active = await q.query(`select bool_or(listener_id = $1) as by_cookie from requests where (status = 'queued' or (status = 'waiting' and created_at > $3)) and (listener_id = $1 or ip_hash = $2)`, [who.listenerId, who.ipHash, cutoff]);
  if (active.rows[0].by_cookie === true) return refuse(409, "active_request", "You already have a request waiting or lined up. Wait for it to play.");
  if (active.rows[0].by_cookie === false) return refuse(409, "network_busy", "Someone on your network already has a request waiting or lined up. Try again once it plays.");
  if (await alreadyComingUp(q, videoId, cutoff)) return refuse(409, "already_coming_up", "That song is already coming up.");
  return null;
}

/** The rate rules, on attempts (every post that reached YouTube, accepted or not): 5/hour per listener or IP, and a global daily cap. */
async function checkRates(q: Queryable, who: Who, now: number): Promise<Refusal | null> {
  const hourly = await q.query("select count(*) filter (where listener_id = $1)::int as mine, count(*)::int as n from request_attempts where at > $3 and (listener_id = $1 or ip_hash = $2)", [who.listenerId, who.ipHash, at(now - 3600_000)]);
  if (hourly.rows[0].n >= MAX_PER_HOUR) {
    const from = hourly.rows[0].mine >= MAX_PER_HOUR ? "" : " from your network";
    return refuse(429, "rate_limited", `That's ${MAX_PER_HOUR} requests this hour${from}. Try again later.`);
  }
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
    await client.query("delete from search_attempts where at <= $1", [cutoff]);
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

export type Moderation = "approve" | "deny" | "remove" | "keep";
export const MODERATIONS: readonly Moderation[] = ["approve", "deny", "remove", "keep"];
type StatusMove = { from: string[]; to: string };
const MODERATION: Record<Exclude<Moderation, "keep">, StatusMove> = {
  approve: { from: ["waiting"], to: "queued" }, // joins the back of the requests line (queued_at = now)
  deny: { from: ["waiting"], to: "denied" },
  remove: { from: ["waiting", "queued", "playing", "played", "expired"], to: "denied" }, // takes down any text; a playing song keeps playing, only its row leaves the feed
};

export type ModerationResult =
  | { ok: true; request: FeedItem; alreadyInLibrary?: true }
  | { ok: false; status: number; error: string; request?: FeedItem; code?: "already_coming_up" };

const REQUEST_COLUMNS = "id, name, dedication, video_id, title, duration_sec, created_at, status";
async function readRequest(q: Queryable, id: number): Promise<FeedItem | null> {
  const { rows } = await q.query(`select ${REQUEST_COLUMNS} from requests where id = $1`, [id]);
  return rows[0] ? toFeedItem(rows[0]) : null;
}

/** approve (waiting -> queued), deny (waiting -> denied), remove (anything not denied -> denied), keep (played or playing: song joins the library). 409 with the current request when its state does not allow the action. */
export async function moderate(db: Db, id: number, action: Moderation, clock: Clock): Promise<ModerationResult> {
  return action === "keep" ? keepRequest(db, id) : moveRequest(db, id, action, clock);
}

async function moveRequest(db: Db, id: number, action: Exclude<Moderation, "keep">, clock: Clock): Promise<ModerationResult> {
  const rule = MODERATION[action];
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const now = clock();
    await expireWaiting(client, now); // a 25h-old waiting request is expired, not approvable
    if (action === "approve" && (await comingUpElsewhere(client, id))) {
      const request = await readRequest(client, id);
      await client.query("commit");
      return request ? { ok: false, status: 409, error: "That song is already coming up.", code: "already_coming_up", request } : { ok: false, status: 404, error: "No such request." };
    }
    const { rows } = await client.query(
      `update requests set status = $2::text, decided_at = $3, queued_at = case when $2::text = 'queued' then $3::timestamptz else queued_at end where id = $1 and status = any($4::text[]) returning video_id, name`,
      [id, rule.to, at(now), rule.from],
    );
    if (rows[0]) await client.query("insert into activity_log (who, what, details) values ('owner', $1, $2)", [`request_${action}`, { id, videoId: rows[0].video_id, name: rows[0].name }]);
    const request = await readRequest(client, id);
    await client.query("commit");
    if (rows[0] && request) return { ok: true, request };
    return request ? { ok: false, status: 409, error: `That request is ${request.status}; ${action} doesn't apply.`, request } : { ok: false, status: 404, error: "No such request." };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The listeners' "already coming up" rule for an approval: the waiting request's song is playing now, in the owner queue, or queued as another request. */
async function comingUpElsewhere(q: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await q.query(
    `select 1 from requests r where r.id = $1 and r.status = 'waiting' and (
       r.video_id = (select current_video_id from station_state where id = 1)
       or exists (select 1 from queue where video_id = r.video_id)
       or exists (select 1 from requests o where o.video_id = r.video_id and o.id <> r.id and o.status in ('queued', 'playing')))`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

const KEEPABLE = ["played", "playing"];

/** Keep: a played or playing request's song joins the library (idempotent). Metadata is re-fetched from YouTube first
 * (outside the lock; the request's stored title may be days old), then the status re-check, add and logs share one transaction. */
async function keepRequest(db: Db, id: number): Promise<ModerationResult> {
  const { rows: peek } = await db.query("select r.status, r.video_id, (s.video_id is not null and s.deleted_at is null) as in_library from requests r left join songs s on s.video_id = r.video_id where r.id = $1", [id]);
  if (!peek[0] || !KEEPABLE.includes(peek[0].status)) return keepRefusal(db, id);
  if (peek[0].in_library) return keepNoop(db, id); // no YouTube call, no quota
  const found = await lookupVideo(peek[0].video_id);
  if (!found.ok) return { ok: false, status: found.status === 404 ? 422 : found.status, error: found.status === 404 ? "YouTube no longer has that video, so it can't be kept." : found.message };
  return keepFetched(db, id, found.info);
}

async function keepNoop(db: Db, id: number): Promise<ModerationResult> {
  const request = await readRequest(db, id);
  return request ? { ok: true, request, alreadyInLibrary: true } : { ok: false, status: 404, error: "No such request." };
}

async function keepRefusal(db: Db, id: number): Promise<ModerationResult> {
  const request = await readRequest(db, id);
  return request ? { ok: false, status: 409, error: `That request is ${request.status}; only played ones can be kept.`, request } : { ok: false, status: 404, error: "No such request." };
}

async function keepFetched(db: Db, id: number, info: PlayableVideo): Promise<ModerationResult> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const { rows } = await client.query("select status, video_id from requests where id = $1", [id]);
    if (!rows[0] || !KEEPABLE.includes(rows[0].status) || rows[0].video_id !== info.videoId) {
      await client.query("commit");
      return keepRefusal(db, id);
    }
    const added = await addToLibrary(client, info);
    if (added) await client.query("update station_state set cycle = jsonb_set(cycle, '{played}', coalesce(cycle->'played', '[]'::jsonb) || to_jsonb($1::text)) where id = 1", [info.videoId]); // heard this cycle: the shuffle must not put a just-kept song first
    await client.query("insert into activity_log (who, what, details) values ('owner', 'request_keep', $1)", [{ id, videoId: info.videoId, alreadyInLibrary: !added }]);
    const request = (await readRequest(client, id))!;
    await client.query("commit");
    return { ok: true, request, ...(!added && { alreadyInLibrary: true as const }) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// A row that is the song on air right now (same rule as loadSongs in schedule.ts: playing, queued, or denied during this song) and has not ended keeps its row.
// Once it has ended it may go: the next visit sees a missing song and moves the station on.
const notOnAir = (nowParam: string) => `not exists (select 1 from station_state s where s.current_video_id = requests.video_id
  and s.started_at_ms + requests.duration_sec * 1000 > ${nowParam}::bigint
  and (requests.status in ('playing', 'queued') or (requests.status = 'denied' and requests.decided_at >= to_timestamp(s.started_at_ms / 1000.0))))`;

/** Daily upkeep, 30-day YouTube metadata rule: no request row (title, duration, category) outlives 30 days.
 * Waiting and queued requests that old are marked expired first (logged) so they never play with stale data; then every finished
 * request (played, denied, expired) that old is deleted. Station lock first, like every writer. */
export async function retireOldRequests(db: Db, clock: Clock): Promise<{ expired: number; deleted: number }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const cutoff = at(clock() - REQUEST_KEEP_DAYS * 24 * 3600_000);
    const stale = await client.query(`update requests set status = 'expired', decided_at = $1 where status in ('waiting', 'queued') and created_at <= $2 and ${notOnAir("$3")} returning id, video_id`, [at(clock()), cutoff, clock()]);
    for (const row of stale.rows) await client.query("insert into activity_log (who, what, details) values ($1, 'request_expired', $2)", [SYSTEM_ACTOR, { id: Number(row.id), videoId: row.video_id }]);
    const gone = await client.query(`delete from requests where status in ('playing', 'played', 'denied', 'expired') and created_at <= $1 and ${notOnAir("$2")}`, [cutoff, clock()]);
    await client.query("commit");
    return { expired: stale.rowCount ?? 0, deleted: gone.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Live waiting requests, one count query (for the badge in every moderate response). */
export async function countWaiting(q: Queryable, clock: Clock): Promise<number> {
  const { rows } = await q.query("select count(*)::int as n from requests where status = 'waiting' and created_at > $1", [at(clock() - WAIT_EXPIRY_MS)]);
  return rows[0].n;
}

export interface ModerationList {
  mode: Mode;
  waitingCount: number;
  waiting: FeedItem[];
  requests: FeedItem[];
}

/** For the owner: every live waiting request (oldest first, with its count) plus the public feed's recent requests, all with ids and statuses. */
export async function listForModeration(db: Db, clock: Clock): Promise<ModerationList> {
  const { rows } = await db.query(`select ${REQUEST_COLUMNS} from requests where status = 'waiting' and created_at > $1 order by id`, [at(clock() - WAIT_EXPIRY_MS)]);
  const waiting = rows.map(toFeedItem);
  return { ...(await listFeed(db, clock)), waitingCount: waiting.length, waiting };
}

// --- public reads (#30). Read-only: a waiting request past 24h shows as expired before the daily cron marks it.

export const FEED_LIMIT = 30;

export interface FeedItem {
  id: number;
  name: string;
  dedication: string;
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  status: string;
  createdAt: string;
}

const toFeedItem = (r: any): FeedItem => ({
  id: Number(r.id),
  name: r.name,
  dedication: r.dedication,
  videoId: r.video_id,
  title: r.title,
  durationSec: r.duration_sec,
  thumbnail: thumbnailOf(r.video_id),
  status: r.status,
  createdAt: r.created_at.toISOString(),
});

/** The last 30 requests, newest first, public fields only. Denied requests are left out. */
export async function listFeed(db: Db, clock: Clock): Promise<{ mode: Mode; requests: FeedItem[] }> {
  const { rows } = await db.query(
    `select id, name, dedication, video_id, title, duration_sec, created_at,
            case when status = 'waiting' and created_at <= $1 then 'expired' else status end as status
       from requests where status <> 'denied' order by id desc limit $2`,
    [at(clock() - WAIT_EXPIRY_MS), FEED_LIMIT],
  );
  return { mode: await getMode(db), requests: rows.map(toFeedItem) };
}

export interface MyRequest {
  id: number;
  videoId: string;
  title: string;
  thumbnail: string;
  status: string;
  createdAt: string;
}

/** The caller's own waiting, queued or playing request (by cookie only; the network backstop is for limits, not for showing someone else's request), or null. */
export async function findMine(db: Db, who: Who, clock: Clock): Promise<MyRequest | null> {
  const { rows } = await db.query(
    `select id, video_id, title, status, created_at from requests
      where (status in ('queued', 'playing') or (status = 'waiting' and created_at > $2)) and listener_id = $1
      order by id desc limit 1`,
    [who.listenerId, at(clock() - WAIT_EXPIRY_MS)],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: Number(r.id), videoId: r.video_id, title: r.title, thumbnail: thumbnailOf(r.video_id), status: r.status, createdAt: r.created_at.toISOString() };
}
