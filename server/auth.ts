import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseBool } from "./env.ts";

/**
 * Single-owner password gate (issue #9). No accounts, no session store:
 * the session is a stateless cookie `v1.<issuedAtMs>.<hmac>` where the HMAC
 * (SHA-256, keyed by SESSION_SECRET) covers the version, the issued-at time and
 * a hash of OWNER_PASSWORD — so changing either env var invalidates every session.
 */

export const SESSION_COOKIE = "ttunes_session";
const VERSION = "v1";
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // owner's own phone stays logged in
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export interface AuthOptions {
  password: string;
  secret: string;
  /** Add the `Secure` cookie attribute (HTTPS only). */
  secure?: boolean;
}

export interface Auth {
  /** POST /api/login, POST /api/logout, GET /api/session. Mount before requireSession. */
  router: Router;
  /** 401s any request without a valid session cookie. */
  requireSession: RequestHandler;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createAuth({ password, secret, secure = false }: AuthOptions): Auth {
  if (!password) throw new Error("createAuth: password is required");
  if (!secret) throw new Error("createAuth: secret is required");

  const passwordHash = sha256(password);
  const passwordTag = passwordHash.toString("base64url");

  const sign = (issuedAt: string) =>
    createHmac("sha256", secret).update(`${VERSION}.${issuedAt}.${passwordTag}`).digest("base64url");

  const issue = () => {
    const issuedAt = String(Date.now());
    return `${VERSION}.${issuedAt}.${sign(issuedAt)}`;
  };

  const isValid = (token: string | undefined): boolean => {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION || !/^\d{1,16}$/.test(parts[1])) return false;
    const expected = Buffer.from(sign(parts[1]));
    const given = Buffer.from(parts[2]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const age = Date.now() - Number(parts[1]);
    return age >= -60_000 && age <= MAX_AGE_MS; // small allowance for clock skew
  };

  const passwordMatches = (given: unknown): boolean =>
    typeof given === "string" && timingSafeEqual(sha256(given), passwordHash);

  // In-memory per-IP failure counter. Single process, so no cross-request race
  // beyond the synchronous read-modify-write below.
  const failures = new Map<string, { count: number; windowStart: number }>();
  const failureEntry = (ip: string, now: number) => {
    const e = failures.get(ip);
    if (!e || now - e.windowStart > FAIL_WINDOW_MS) {
      failures.delete(ip);
      return undefined;
    }
    return e;
  };
  const prune = (now: number) => {
    for (const [ip, e] of failures) if (now - e.windowStart > FAIL_WINDOW_MS) failures.delete(ip);
  };

  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };

  const router = express.Router();

  const recordFailure = (ip: string, now: number) => {
    if (failures.size > 10_000) prune(now);
    const entry = failureEntry(ip, now);
    if (entry) entry.count++;
    else failures.set(ip, { count: 1, windowStart: now });
  };

  const jsonParser = express.json({ limit: "4kb" });

  // Keyed on req.ip, which is the real client only when the app's "trust proxy"
  // setting matches the deployment (TRUST_PROXY=1 on Fly.io). Without it, every
  // client behind a proxy shares the proxy's bucket.
  router.post("/api/login", (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const entry = failureEntry(ip, now);
    if (entry && entry.count >= MAX_FAILURES) {
      const retryAfter = Math.ceil((entry.windowStart + FAIL_WINDOW_MS - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      res.status(429).json({ error: "too many attempts, try again later" });
      return;
    }
    // Not a JSON request at all: reject without counting, it never reached the password check.
    if (!req.is("application/json")) {
      res.status(400).json({ error: "bad request" });
      return;
    }
    jsonParser(req, res, (err?: unknown) => {
      if (err) {
        // Malformed / oversized JSON. body-parser's error carries the raw body
        // (the attempted password) in err.body and often in err.message, so it
        // is never logged or passed on. Counted as a failed attempt.
        recordFailure(ip, now);
        res.status(400).json({ error: "bad request" });
        return;
      }
      const body: unknown = req.body;
      const given = body && typeof body === "object" ? (body as { password?: unknown }).password : undefined;
      if (!passwordMatches(given)) {
        recordFailure(ip, now);
        res.status(401).json({ error: "wrong password" });
        return;
      }
      failures.delete(ip);
      res.cookie(SESSION_COOKIE, issue(), { ...cookieOptions, maxAge: MAX_AGE_MS });
      res.status(204).end();
    });
  });

  router.post("/api/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get("/api/session", (req: Request, res: Response) => {
    res.status(isValid(readCookie(req.headers.cookie, SESSION_COOKIE)) ? 204 : 401).end();
  });

  const requireSession: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (isValid(readCookie(req.headers.cookie, SESSION_COOKIE))) {
      next();
      return;
    }
    res.status(401).json({ error: "login required" });
  };

  return { router, requireSession };
}

/**
 * Reads OWNER_PASSWORD / SESSION_SECRET / COOKIE_SECURE / NODE_ENV.
 * Production without OWNER_PASSWORD (or SESSION_SECRET) throws; dev without
 * OWNER_PASSWORD returns undefined (auth off) and warns.
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): Auth | undefined {
  const production = env.NODE_ENV === "production";
  const password = env.OWNER_PASSWORD;
  if (!password) {
    if (production) throw new Error("OWNER_PASSWORD must be set when NODE_ENV=production; refusing to start.");
    console.warn("WARNING: OWNER_PASSWORD is not set — auth is OFF. Anyone who can reach this server can use it.");
    return undefined;
  }
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set when OWNER_PASSWORD is set; refusing to start.");
  }
  const secure = parseBool(env.COOKIE_SECURE, production, "COOKIE_SECURE");
  return createAuth({ password, secret, secure });
}
