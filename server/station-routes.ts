import express, { Router, type NextFunction, type Request, type Response } from "express";
import { StationError, type StationService, type StationView } from "./station.ts";

/** `/api/station` endpoints (mounted by createApp). Every success returns the full station. */
export function stationRouter(station: StationService): Router {
  const router = Router();
  router.use(express.json());

  const send = async (res: Response, work: Promise<StationView>) => {
    res.json(await work);
  };

  router.get("/", (_req, res) => send(res, station.get()));

  router.put("/now-playing", (req, res) => {
    const { trackId, offsetSec, playing } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof trackId !== "string" || !trackId) return badRequest(res, "trackId must be a non-empty string");
    if (typeof offsetSec !== "number" || !Number.isFinite(offsetSec) || offsetSec < 0) {
      return badRequest(res, "offsetSec must be a number >= 0");
    }
    if (typeof playing !== "boolean") return badRequest(res, "playing must be a boolean");
    return send(res, station.report({ trackId, offsetSec, playing }));
  });

  router.post("/next", (_req, res) => send(res, station.next()));

  router.post("/play-now", (req, res) => {
    const trackId = trackIdFrom(req, res);
    return trackId && send(res, station.playNow(trackId));
  });

  router.post("/queue", (req, res) => {
    const trackId = trackIdFrom(req, res);
    return trackId && send(res, station.enqueue(trackId));
  });

  router.delete("/queue/:index", (req, res) => {
    const raw = String(req.params.index);
    if (!/^\d+$/.test(raw)) return badRequest(res, "index must be a non-negative integer");
    return send(res, station.dequeue(Number(raw)));
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

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error });
}

function trackIdFrom(req: Request, res: Response): string | undefined {
  const trackId = (req.body as { trackId?: unknown } | undefined)?.trackId;
  if (typeof trackId === "string" && trackId) return trackId;
  badRequest(res, "trackId must be a non-empty string");
  return undefined;
}
