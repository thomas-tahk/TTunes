import express, { Router, type NextFunction, type Request, type Response } from "express";
import { StationError, type StationService, type StationView } from "./station.ts";

/**
 * `/api/station` endpoints (mounted by createApp, behind the session gate). Every success
 * returns the full station; a request ignored as stale returns it with `stale: true`
 * (see "Stale requests" in station.ts).
 *
 *   GET    /                    station
 *   PUT    /now-playing         { trackId, offsetSec, playing, fromTrackId? }
 *   POST   /next                { fromTrackId? }
 *   POST   /play-now            { trackId }
 *   POST   /queue               { trackId }                 409 "queue full" at the cap
 *   DELETE /queue/:index        ?trackId=  (optional guard) 409 "queue changed" on mismatch
 */
export function stationRouter(station: StationService): Router {
  const router = Router();
  router.use(express.json());

  const send = async (res: Response, work: Promise<StationView>) => {
    res.json(await work);
  };

  router.get("/", (_req, res) => send(res, station.get()));

  router.put("/now-playing", (req, res) => {
    const { trackId, offsetSec, playing, fromTrackId } = body(req);
    if (!isId(trackId)) return badRequest(res, "trackId must be a non-empty string");
    if (typeof offsetSec !== "number" || !Number.isFinite(offsetSec) || offsetSec < 0) {
      return badRequest(res, "offsetSec must be a number >= 0");
    }
    if (typeof playing !== "boolean") return badRequest(res, "playing must be a boolean");
    if (fromTrackId !== undefined && !isId(fromTrackId)) return badRequest(res, "fromTrackId must be a non-empty string");
    return send(res, station.report({ trackId, offsetSec, playing, fromTrackId }));
  });

  router.post("/next", (req, res) => {
    const { fromTrackId } = body(req);
    if (fromTrackId !== undefined && !isId(fromTrackId)) return badRequest(res, "fromTrackId must be a non-empty string");
    return send(res, station.next(fromTrackId));
  });

  router.post("/play-now", (req, res) => {
    const { trackId } = body(req);
    if (!isId(trackId)) return badRequest(res, "trackId must be a non-empty string");
    return send(res, station.playNow(trackId));
  });

  router.post("/queue", (req, res) => {
    const { trackId } = body(req);
    if (!isId(trackId)) return badRequest(res, "trackId must be a non-empty string");
    return send(res, station.enqueue(trackId));
  });

  router.delete("/queue/:index", (req, res) => {
    const raw = String(req.params.index);
    if (!/^\d+$/.test(raw)) return badRequest(res, "index must be a non-negative integer");
    const trackId = req.query.trackId;
    if (trackId !== undefined && !isId(trackId)) return badRequest(res, "trackId must be a non-empty string");
    return send(res, station.dequeue(Number(raw), trackId));
  });

  // StationError / bad JSON → its status; anything else goes on to the app's 500 handler.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof StationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // body-parser: malformed or oversized JSON carries a 4xx status.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid request body" });
      return;
    }
    next(err);
  });

  return router;
}

const body = (req: Request): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error });
}
