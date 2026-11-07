import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errors, jwtVerify, SignJWT } from "jose";
import { sharedDb, type Db } from "./db.ts";

// Pinned by numeric GitHub id (login names can be renamed and reclaimed).
export const OWNER_GITHUB_ID = 10647431;
export const SESSION_COOKIE = "ttunes_session";
export const STATE_COOKIE = "ttunes_oauth_state";
export const SESSION_SECONDS = 7 * 24 * 3600;

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  if (Buffer.byteLength(secret) < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
  return secret;
}

/** HS256 signing key shared by every signed cookie (owner session, listener id); tokens differ by claims, not by key. */
export function sessionKey(): Uint8Array {
  return new TextEncoder().encode(sessionSecret());
}

export function isOwnerId(id: unknown): boolean {
  return id === OWNER_GITHUB_ID;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed percent-encoding: skip this cookie
    }
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function currentSessionVersion(db: Db): Promise<number> {
  const { rows } = await db.query("select session_version from auth_state where id = 1");
  if (!rows[0]) throw new Error("auth_state row missing: run migrations");
  return rows[0].session_version;
}

export async function bumpSessionVersion(db: Db): Promise<number> {
  const { rows } = await db.query("update auth_state set session_version = session_version + 1 where id = 1 returning session_version");
  return rows[0].session_version;
}

/** Signed session cookie value for the owner, tied to the current session version. */
export async function issueSession(db: Db): Promise<string> {
  const ver = await currentSessionVersion(db);
  return new SignJWT({ ver })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(OWNER_GITHUB_ID))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(sessionKey());
}

/** True only for an untampered, unexpired cookie of the owner at the current session version. */
export async function requireOwner(req: IncomingMessage, db: Db = sharedDb()): Promise<boolean> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ["HS256"], requiredClaims: ["exp"] });
    if (payload.sub !== String(OWNER_GITHUB_ID)) return false;
    return payload.ver === (await currentSessionVersion(db));
  } catch (error) {
    if (error instanceof errors.JOSEError) return false; // bad, expired or wrong-alg token
    throw error; // config or DB failure must not look like "not owner"
  }
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function statesMatch(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}
