import type { Express, Request, Response } from "express";
import { SearchError, type YtSearchRunner } from "../search.ts";

// Candidate videos for "artist – song"; the user picks one and it is staged like a pasted link.
export function registerSearchRoutes(app: Express, search: YtSearchRunner): void {
  app.get("/api/search", async (req: Request, res: Response) => {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "no query provided" });
      return;
    }
    try {
      res.json(await search(query));
    } catch (err) {
      res.status(422).json({ error: err instanceof SearchError ? err.message : "Search failed." });
    }
  });
}
