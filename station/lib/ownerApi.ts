import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOwner, sendJson } from "./auth.ts";
import { readJson } from "./body.ts";
import { sharedDb, type Db } from "./db.ts";
import type { Outcome } from "./owner.ts";

export interface OwnerCall {
  db: Db;
  body: Record<string, unknown>;
  url: URL;
}
export type OwnerResult = { status: number; body: unknown };
export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

export const fromOutcome = <T>(outcome: Outcome<T>, wrap: (value: T) => unknown = (v) => v): OwnerResult =>
  outcome.ok ? { status: 200, body: wrap(outcome.value) } : { status: outcome.status, body: { error: outcome.error } };

/** Shared shell for owner endpoints: method check, 401 without the owner cookie, JSON body, 500 on failure. */
export function ownerEndpoint(method: string, run: (call: OwnerCall) => Promise<OwnerResult>): Handler {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== method) return sendJson(res, 405, { error: `${method} only` });
    try {
      if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
      const body = await readJson(req);
      const result = await run({ db: sharedDb(), body, url: new URL(req.url ?? "/", "http://x") });
      sendJson(res, result.status, result.body);
    } catch (error) {
      console.error(`${method} ${req.url} failed`, error);
      sendJson(res, 500, { error: "owner action failed" });
    }
  };
}

/** Picks a handler by HTTP method. */
export function byMethod(handlers: Record<string, Handler>): Handler {
  return (req, res) => {
    const handler = handlers[req.method ?? ""];
    if (handler) return handler(req, res);
    return sendJson(res, 405, { error: `${Object.keys(handlers).join(" or ")} only` });
  };
}

/**
 * One Vercel function serves a whole /api/<base>/* tree (Hobby allows 12 functions). The path after the base comes from the
 * request path (dev server, tests) or from the `route` query parameter the vercel.json rewrite adds.
 */
export function router(base: string, routes: Record<string, Handler>): Handler {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const prefix = `/api/${base}/`;
    const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : (url.searchParams.get("route") ?? "");
    const handler = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!handler) return sendJson(res, 404, { error: "not found" });
    return handler(req, res);
  };
}
