import type { Db } from "../../db.ts";
import { byMethod, ownerEndpoint } from "../../ownerApi.ts";
import { getMode, listForModeration, MODERATIONS, MODES, moderate, setMode, type Mode, type Moderation } from "../../requests.ts";

// All owner-only (401 without the session cookie). Every write takes the station lock and writes an activity_log row.
//
// GET  /api/owner/requests -> {mode, waitingCount, waiting:[Item], requests:[Item]}
//      waiting = live waiting requests, oldest first (waitingCount = its length, for the badge: no polling needed);
//      requests = the recent public feed, newest first, max 30 (denied ones are not in it). Item = {id,name,dedication,videoId,title,durationSec,thumbnail,status,createdAt}.
// POST /api/owner/requests/moderate {id, action: approve|deny|remove|keep} -> {request: Item, waitingCount, alreadyInLibrary?}
//      approve: waiting -> queued, at the back of the requests line. deny: waiting -> denied. remove: any status but denied -> denied (hidden from the feed;
//      a playing song keeps playing, use skip to stop it). keep: played or playing -> the song joins the library (alreadyInLibrary:true when it was there).
//      400 {error} bad id/action; 404 {error} no such request; 409 {error, request: Item, waitingCount} the request's current state does not allow the action.
// GET  /api/owner/requests/mode -> {mode: open|approve|off}
// POST /api/owner/requests/mode {mode} -> {mode}; 400 {error} for an unknown mode.

const waitingCount = async (db: Db): Promise<number> => (await listForModeration(db, Date.now)).waitingCount;

export const requestsList = ownerEndpoint("GET", async ({ db }) => ({ status: 200, body: await listForModeration(db, Date.now) }));

export const requestModerate = ownerEndpoint("POST", async ({ db, body }) => {
  const { id, action } = body;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return { status: 400, body: { error: "id must be a request id" } };
  if (typeof action !== "string" || !MODERATIONS.includes(action as Moderation)) return { status: 400, body: { error: `action must be one of ${MODERATIONS.join(", ")}` } };
  const result = await moderate(db, id, action as Moderation, Date.now);
  if (result.ok) return { status: 200, body: { request: result.request, waitingCount: await waitingCount(db), ...(result.alreadyInLibrary && { alreadyInLibrary: true }) } };
  if (result.status === 404) return { status: 404, body: { error: result.error } };
  return { status: 409, body: { error: result.error, request: result.request, waitingCount: await waitingCount(db) } };
});

export const requestMode = byMethod({
  GET: ownerEndpoint("GET", async ({ db }) => ({ status: 200, body: { mode: await getMode(db) } })),
  POST: ownerEndpoint("POST", async ({ db, body }) => {
    const mode = body.mode;
    if (typeof mode !== "string" || !MODES.includes(mode as Mode)) return { status: 400, body: { error: `mode must be one of ${MODES.join(", ")}` } };
    await setMode(db, mode as Mode);
    return { status: 200, body: { mode } };
  }),
});
