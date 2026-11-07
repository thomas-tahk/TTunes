import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { jwtVerify, SignJWT } from "jose";
import { cookieHeader, parseCookies } from "./auth.ts";

export const LISTENER_COOKIE = "ttunes_listener";
const LISTENER_AUDIENCE = "ttunes-listener"; // the owner session has no `aud` and requires `sub`, so neither token passes as the other
const LISTENER_SECONDS = 365 * 24 * 3600;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set");
  if (Buffer.byteLength(value) < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
  return value;
}

/** Salt for IP hashes: IP_HASH_SALT if set, else derived from SESSION_SECRET (rotating SESSION_SECRET then orphans old hashes, which only loosens the backstop). */
function ipSalt(): string {
  return process.env.IP_HASH_SALT || createHmac("sha256", secret()).update("ttunes-ip-hash-salt").digest("hex");
}

export const hashIp = (ip: string): string => createHmac("sha256", ipSalt()).update(ip).digest("hex");

/** Client IP. Vercel overwrites x-forwarded-for with the real client address; locally the socket address is the fallback. */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

export interface Listener {
  id: string;
  setCookie: string | null; // set when a new id was issued
  ipHash: string;
}

/** The listener's id from the signed cookie, or a fresh id (with the Set-Cookie to send) when missing or invalid. */
export async function identifyListener(req: IncomingMessage): Promise<Listener> {
  const ipHash = hashIp(clientIp(req));
  const token = parseCookies(req.headers.cookie)[LISTENER_COOKIE];
  const key = new TextEncoder().encode(secret());
  if (token) {
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], audience: LISTENER_AUDIENCE });
      if (typeof payload.lid === "string" && payload.lid) return { id: payload.lid, setCookie: null, ipHash };
    } catch {
      // bad, expired or foreign token: issue a new id
    }
  }
  const id = randomUUID();
  const jwt = await new SignJWT({ lid: id }).setProtectedHeader({ alg: "HS256" }).setAudience(LISTENER_AUDIENCE).setIssuedAt().setExpirationTime(`${LISTENER_SECONDS}s`).sign(key);
  return { id, setCookie: cookieHeader(LISTENER_COOKIE, jwt, LISTENER_SECONDS), ipHash };
}
