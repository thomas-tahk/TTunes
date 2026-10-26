# TTunes

A personal, always-on music station. Curate your own library, shuffle 24/7, and ask an AI to fetch specific tracks on request.

**Status:** building M1 ("on my phone, from the cloud"): upload, streaming, owner password, Postgres + R2 storage, the server-owned station, and a Docker image with CI are in; the phone player is in progress. Not deployed yet.

## Run it

- **Dev:** `npm ci && npm run dev` (no password, local files; open the URL vite prints).
- **Docker, whole stack on one box:** `OWNER_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) docker compose up -d --build`, then open http://localhost:18080.
- **Cloud (Fly.io + Cloudflare R2 + Neon) and home lab:** step by step in [docs/deploy.md](docs/deploy.md), with every environment variable listed.
- **Checks:** `npm run typecheck`, `npm test`, `scripts/smoke.sh` (container end to end). CI runs all three on every push.
