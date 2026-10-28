# Host pricing — Railway vs Fly.io (checked 2026-10-26, cloud build of M1)

Sources (official pages were unreachable from the cloud container, so read via search results):
- Fly.io resource pricing — https://fly.io/docs/about/pricing/ : shared-cpu-1x 256MB ≈ $1.94/mo, billed per second; pay-as-you-go only for new orgs (no free allowance), card required after a short trial. 512MB is roughly $3.3/mo. Egress (North America) ~$0.02/GB.
- Railway plans — https://docs.railway.com/reference/pricing/plans : Hobby $5/mo including $5 of usage; RAM $10/GB/mo, vCPU $20/vCPU/mo, egress $0.05–0.10/GB, volumes $0.15/GB/mo.
- Third-party 2026 comparisons (sota.io, temps.sh) agree on the ordering.

**Pick: Fly.io, one shared-cpu-1x / 512MB machine, always on (`auto_stop_machines = "off"`, `min_machines_running = 1`).**
Roughly $3–4/mo vs Railway's $5 floor; audio is proxied through the container, so egress price matters and Fly's is lower.
Portability: the image is a plain Dockerfile with config from env vars only; `fly.toml` is the only host-specific file, so moving to the home lab is `docker compose up` with the same env.
Status: verified from search snippets, not from an invoice — re-check when he creates the account.
