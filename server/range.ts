import type { Request, Response } from "express";
import { pipeline, type Readable } from "node:stream";

export interface RangedSource {
  size: number;
  contentType: string;
  open: (start: number, end: number) => Readable;
}

// Range-aware streaming so the browser can seek and start playback before the
// full file arrives. Multi-range requests get only their first range. Per RFC
// 9110 a malformed or non-bytes Range is ignored (full file); only an
// unsatisfiable one is a 416.
export function sendRanged(req: Request, res: Response, source: RangedSource): void {
  const { size, contentType } = source;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  const parsed = req.headers.range ? req.range(size) : undefined;
  if (parsed === -1) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  if (!Array.isArray(parsed) || parsed.type !== "bytes") {
    sendBytes(res, source, 0, size - 1, 200);
    return;
  }
  const { start, end } = parsed[0];
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  sendBytes(res, source, start, end, 206);
}

// Headers stay unflushed until the first data chunk, so an open failure can still become a 404.
function sendBytes(res: Response, source: RangedSource, start: number, end: number, status: number): void {
  res.status(status).setHeader("Content-Length", Math.max(end - start + 1, 0));
  if (end < start) return void res.end(); // empty file
  const stream = source.open(start, end);
  // Registered before pipeline() so it answers 404 before pipeline tears the response down.
  stream.once("error", () => {
    if (!res.headersSent) failBeforeHeaders(res);
  });
  pipeline(stream, res, () => {}); // closes the file if the client aborts
}

function failBeforeHeaders(res: Response): void {
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"]) res.removeHeader(name);
  res.status(404).end();
}
