import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { join, resolve } from "node:path";

// Registered last so API/audio routes win; unknown GETs get index.html (SPA fallback).
export function registerStaticRoutes(app: Express, staticDir: string): void {
  app.use(express.static(staticDir));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isApiOrAudio = /^\/(api|audio)(\/|$)/.test(req.path);
    if (req.method !== "GET" || isApiOrAudio) return next();
    res.sendFile(join(resolve(staticDir), "index.html"));
  });
}
