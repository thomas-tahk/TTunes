import type { NextFunction, Request, Response } from "express";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Defence against other websites driving the local API from the user's browser:
// - Host check blocks DNS rebinding (attacker's domain re-pointed at 127.0.0.1).
// - Origin check blocks forged cross-site writes (uploads/deletes) from a web page.
export function requireLocalRequest(req: Request, res: Response, next: NextFunction): void {
  const host = String(req.headers.host ?? "");
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin !== undefined && !isSameHost(String(origin), host)) {
    res.status(403).json({ error: "cross-site request blocked" });
    return;
  }
  next();
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

function isSameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
