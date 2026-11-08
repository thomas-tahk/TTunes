# Hosting research: Vercel Hobby + Neon Free (2026-11-07)

Sources are official docs, fetched 2026-11-07. Items marked INFERENCE are my own arithmetic or reading, not a doc claim.

## 1. Vercel Hobby

| Fact | Source |
|---|---|
| Hobby is free. Included monthly: 1,000,000 function invocations, 4 Active CPU-hrs, 360 GB-hrs memory, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, 1,000,000 CDN requests | https://vercel.com/docs/plans/hobby |
| Exceed a limit: wait 30 days before using the feature again (in most cases) | https://vercel.com/docs/plans/hobby |
| Function max duration 300s; 100 deployments/day; 200 projects | https://vercel.com/docs/plans/hobby |
| Runtime logs kept 1 hour | https://vercel.com/docs/plans/hobby |
| Cron: Hobby is once per day only, timing precision +/-59 min; faster expressions fail the deploy | https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Env vars: 64 KB total per deployment | https://vercel.com/docs/limits |

**Non-commercial rule** (https://vercel.com/docs/limits/fair-use-guidelines): Hobby is "non-commercial personal use only". Commercial means financial gain of anyone involved in production. Examples: payment from visitors, advertising a sale, being paid to build or host, affiliate-primary sites, "inclusion of advertisements ... like Google AdSense". "Asking for Donations does not fall under commercial usage."
- A free personal radio station and portfolio piece is fine.
- OPEN (INFERENCE): YouTube's own ads inside the embedded player are not ads the site includes. Docs do not address it. Ask Vercel support only if it matters.
- Don't add a tip jar tied to a service, AdSense, or paid features.

**Plan-breaker check (INFERENCE, arithmetic):** the shared schedule means each open listener tab will poll "what's playing now". Polling every 5s is 518,400 requests per tab-month (86,400 x 30 / 5). A few always-open tabs would blow the 1M invocation allotment.
- Mitigation: fetch the schedule once on join, then compute the offset client-side from server timestamps. Re-poll only at song end, or every 60s or more.
- Mitigation: also cache the endpoint at the CDN.

## 2. Neon Free

| Fact | Source |
|---|---|
| 1 GB storage per project (20 GB per account); 100 CU-hours per project per month (about 400 h at 0.25 CU); 100 projects | https://neon.com/docs/introduction/plans |
| Scale to zero after 5 min idle; fixed, cannot be disabled on Free | https://neon.com/docs/introduction/plans, https://neon.com/docs/introduction/scale-to-zero |
| Suspended computes don't accrue CU-hours | https://neon.com/docs/introduction/plans |
| "None of these limits delete your data." Over storage cap: writes that grow storage are blocked. Over CU-hours: compute suspends until next period | https://neon.com/docs/introduction/plans |
| Wake-up "typically takes a few hundred milliseconds", excluding network and other services' startup | https://neon.com/docs/connect/connection-latency |
| Recommended: co-locate app and DB region, raise connection timeout (example 10 s), retry with backoff | https://neon.com/docs/connect/connection-latency |
| Instant restore history limited to 6 h on Free | https://neon.com/docs/introduction/plans |

- **Would a listener notice a cold start?** Mostly no. A few hundred ms on the first request after 5 min idle is hidden by the join flow, since the listener has to click Play anyway. Keep the DB in the same region as the Vercel functions.
- **Idle retention:** the plans page lists no inactivity deletion, and says limits don't delete data. Not stated: whether Neon deletes long-idle free projects. OPEN. The pages I read are silent, so don't claim it's safe forever. Keep a periodic export of the library (small).

**Plan-breaker check (INFERENCE):** a station "that never stops" with constant polling keeps Neon awake 24/7. 24 h x 30 d x 0.25 CU = 180 CU-hours, over the 100 CU-hour cap. Then compute suspends until the next period and the station goes down.
- Mitigation: serve the "now playing" read from the CDN cache or memory, not the DB.
- Mitigation: touch the DB only on song change (advance, add, request), and let it sleep otherwise.
- Mitigation: keep the schedule computable from the last DB write, and keep cron (daily only) out of the critical path.
- Needs a design decision in M2.

## 3. Request limit and admin auth

**Who advances the song?** Hobby cron can't (daily only). Advance lazily: any client or request that finds the current song ended computes and writes the next one in a transaction (with a row lock or compare-and-set so two listeners don't both advance). INFERENCE.

**One queued request per listener, no accounts**
- Vercel sets `x-forwarded-for` to the client's public IP and overwrites incoming values "to prevent IP spoofing". `x-real-ip` is identical. Source: https://vercel.com/docs/headers/request-headers. So IP is trustworthy here, but shared by households, offices and carriers.
- A signed httpOnly cookie is per browser and survives IP changes. It is trivially reset by clearing cookies or using a private window. INFERENCE.
- Recommended (INFERENCE): do both.
  - Cookie: a random listener id, HMAC-signed with a secret env var, long Max-Age. This is the primary key for "one queued request".
  - IP: a looser backstop, e.g. at most 3 queued per IP.
  - Both are good enough for friends and family, not abuse-proof. That matches the vision's accepted limit. The off switch is the real protection.
- Signing pattern: Next.js docs use `jose` (`SignJWT`/`jwtVerify`, HS256) with a secret from `openssl rand -base64 32` in an env var. Cookie options: HttpOnly, Secure, SameSite=lax, Max-Age/Expires, Path. Cookies set server-side. Source: https://nextjs.org/docs/app/guides/authentication

**Owner-only admin with one passcode**
- Stack assumed to be Next.js on Vercel (INFERENCE; the repo choice is open).
- Passcode in an env var `ADMIN_PASSCODE`. Env vars sit on Vercel project settings, up to 64 KB (https://vercel.com/docs/limits).
- Login route compares with `crypto.timingSafeEqual` (same pattern as Vercel's own signature-verify example: https://vercel.com/docs/headers/request-headers), then sets a signed session cookie: HttpOnly, Secure, SameSite=lax, 7-day expiry (Next.js example above).
- Every admin route handler and server action must re-verify the cookie. Next.js: treat route handlers and server actions like public endpoints. Proxy/middleware checks alone are not enough.
- Add rate limiting on the login route, because a single passcode is brute-forceable. Options: a failed-attempt counter in Postgres by IP, or Vercel WAF custom rules (Hobby: up to 3, https://vercel.com/docs/plans/hobby). Pick later.
- Vercel Password Protection is a Pro feature ($20/month/project), so not applicable. Source: https://vercel.com/docs/plans/hobby

## Vision assumptions

| Assumption | Status |
|---|---|
| Vercel + Neon costs $0 | VERIFIED for a small site, with a hard condition: polling must be designed so invocations stay under 1M/month and Neon is not kept awake 24/7 (see plan-breaker checks) |
| Never pauses in a way listeners notice | PARTLY VERIFIED: Neon wake is a few hundred ms. OPEN: whether Neon removes long-idle free projects (docs read are silent) |
| Neon plan limits (1 GB, 100 CU-h) | VERIFIED, with the 24/7-awake caveat. Not Supabase, as intended |
| Hobby non-commercial fits a personal/portfolio site | VERIFIED. YouTube-player ads: OPEN, not addressed in the docs |
| One queued request per listener via cookie or IP, no accounts | VERIFIED as feasible. Vercel overwrites XFF so IP is not spoofable by the client. Use a signed cookie plus an IP backstop. Not abuse-proof |
| Owner passcode via env var + httpOnly cookie | VERIFIED, pattern from Next.js docs. Needs login rate limiting |
| Hobby cron could advance the schedule | REFUTED: daily only. Advance lazily on request |
| YouTube IFrame / Data API items | NOT RESEARCHED in this pass |
