import type { Request, Response } from "express";
import type { Readable } from "node:stream";

export interface RangedSource {
  size: number;
  contentType: string;
  open: (start: number, end: number) => Readable;
}

// Range-aware streaming so the browser can seek and start playback before the
// full file arrives. Multi-range requests get only their first range.
export function sendRanged(req: Request, res: Response, source: RangedSource): void {
  const { size, contentType, open } = source;
  const base = { "Accept-Ranges": "bytes", "Content-Type": contentType };
  if (!req.headers.range) {
    res.writeHead(200, { ...base, "Content-Length": size });
    pipeBytes(open, 0, size - 1, res);
    return;
  }
  const parsed = req.range(size);
  if (!Array.isArray(parsed) || parsed.type !== "bytes" || parsed.length === 0) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  const { start, end } = parsed[0];
  res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  pipeBytes(open, start, end, res);
}

function pipeBytes(open: RangedSource["open"], start: number, end: number, res: Response): void {
  if (end < start) return void res.end(); // empty file
  open(start, end).pipe(res);
}
