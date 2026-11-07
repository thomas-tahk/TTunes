import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { jwtVerify, SignJWT } from "jose";
import { cookieHeader, parseCookies, sessionKey, sessionSecret } from "./auth.ts";

export const LISTENER_COOKIE = "ttunes_listener";
const LISTENER_AUDIENCE = "ttunes-listener"; // the owner session has no `aud` and requires `sub`, so neither token passes as the other
const LISTENER_SECONDS = 365 * 24 * 3600;

/** Salt for IP hashes: IP_HASH_SALT if set, else derived from SESSION_SECRET (rotating SESSION_SECRET then orphans old hashes, which only loosens the backstop). */
function ipSalt(): string {
  return process.env.IP_HASH_SALT || createHmac("sha256", sessionSecret()).update("ttunes-ip-hash-salt").digest("hex");
}

/** What identifies a network: the full address for IPv4, the /64 prefix for IPv6 (one household holds a whole /64). */
export function ipKey(ip: string): string {
  const address = ip.split("%")[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":");
}

export const hashIp = (ip: string): string => createHmac("sha256", ipSalt()).update(ipKey(ip)).digest("hex");

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
  const key = sessionKey();
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
