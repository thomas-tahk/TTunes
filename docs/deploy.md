# Deploying TTunes

TTunes is one Docker image. All of its settings come from environment variables, so the
same image runs on Fly.io now and on your home-lab server later. Three services hold
your stuff:

- **Cloudflare R2**: the audio files.
- **Neon**: the Postgres database (the track list).
- **Fly.io**: runs the container, always on, one small machine (shared-cpu-1x, 512 MB, about $3–4 a month).

Do the steps in order. Keep a scratch note open: you will copy five values out of
Cloudflare and Neon and paste them into one `fly secrets set` command at step 9.

## Cloud deploy (Fly.io + R2 + Neon)

1. **Make the R2 bucket.** In the Cloudflare dashboard, go to **R2 Object Storage** and
   create a bucket, for example `ttunes`. Pick a location hint near you (Eastern North America).
   Write down the bucket name.

2. **Note your R2 endpoint.** On the R2 overview page, copy your **Account ID**. Your S3
   endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

3. **Make an R2 API token.** In R2, choose **Manage API tokens** → **Create API token**.
   Set permission to **Object Read & Write** and scope it to **only the `ttunes` bucket**.
   Create it and copy the **Access Key ID** and **Secret Access Key** (the secret is shown once).
   When TTunes starts it checks the bucket with a HeadBucket call. If the deploy log says
   `S3 storage check failed ... access denied`, the token cannot see the bucket: check the
   bucket scope, and if it still fails, recreate the token with **Admin Read & Write** on that bucket.

4. **Make the database.** Sign in to Neon, create a project (region: AWS US East, to sit
   next to the Fly machine), and open **Connection details**. Copy the connection string.
   Replace everything after the `?` with `sslmode=verify-full`, so it ends like
   `.../neondb?sslmode=verify-full`. That makes the connection encrypted and checks Neon's
   certificate. TTunes creates its own tables on first start; you don't run anything.

5. **Install the Fly CLI and sign in.** Follow https://fly.io/docs/flyctl/install/, then run
   `fly auth login`. Fly needs a card on file.

6. **Pick the app name.** Open `fly.toml` and change `app = "ttunes"` to a name nobody else
   has used, for example `ttunes-yourname`. It becomes `https://<name>.fly.dev`.
   `primary_region = "iad"` (Virginia) is set for the US East coast; change it if you live elsewhere.

7. **Create the Fly app without deploying.** From the repo folder run:
   ```
   fly launch --no-deploy --copy-config
   ```
   Say **no** if it offers to set up a Postgres, Redis or Tigris database for you (Neon and R2 are used instead).

8. **Make a session secret.** Run `openssl rand -hex 32` and copy the output. Also choose
   the password you will type on your phone.

9. **Give Fly the secrets.** One command, with your values in place of the `<...>` parts
   (keep the quotes):
   ```
   fly secrets set --stage \
     OWNER_PASSWORD='<your password>' \
     SESSION_SECRET='<output of openssl rand -hex 32>' \
     DATABASE_URL='<Neon string ending ?sslmode=verify-full>' \
     S3_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com' \
     S3_BUCKET='ttunes' \
     S3_ACCESS_KEY_ID='<R2 access key id>' \
     S3_SECRET_ACCESS_KEY='<R2 secret access key>' \
     S3_REGION='auto'
   ```
   `--stage` stores them for the next deploy instead of restarting anything. Secrets never
   go in `fly.toml` or in git. Check what is set (names only) with `fly secrets list`.

10. **Deploy.** Run `fly deploy`. It builds the image, starts one machine and waits for
    `/health` to pass. If it fails, `fly logs` shows why. Every startup problem (missing
    password, wrong bucket, bad database URL) is a single clear line there.

11. **Open it on your phone.** Go to `https://<name>.fly.dev`, log in with your password,
    and add it to your home screen. You stay logged in for a year on that phone.

Changing the password or the session secret later (`fly secrets set OWNER_PASSWORD=...`)
logs out every device.

## Home lab later

Same image, no Fly. On the server, from the repo folder:

```
cp .env.example .env    # or write .env by hand: OWNER_PASSWORD=..., SESSION_SECRET=...
docker compose up -d --build
```

`docker-compose.yml` runs the app plus its own Postgres and MinIO (S3-compatible storage),
keeping data in Docker volumes, and publishes only the app on port 18080 (`TTUNES_PORT` to
change it). Put it behind your own HTTPS reverse proxy and set `COOKIE_SECURE=true` and
`TRUST_PROXY=1` in `.env`. To keep using R2 and Neon from home instead, run just the app
container with the same variables as step 9:
`docker run -d -p 8080:8080 --env-file ttunes.env <image>`.

Simplest possible box (no Postgres, no S3 — the track list lives in a JSON file and the audio on
disk): `docker run -d -p 8080:8080 -e OWNER_PASSWORD=... -e SESSION_SECRET=... -v ttunes-uploads:/app/uploads -v ttunes-data:/app/data <image>`.
Mount **both** volumes, or recreating the container loses the music or the track list. If you
use a host folder instead of a named volume, give it to uid 1000 first (`sudo chown -R 1000:1000 <folder>`),
otherwise the container stops at startup with `EACCES`.

## Every environment variable

| Name | Required? | Example | What it does |
|---|---|---|---|
| `OWNER_PASSWORD` | Yes in production | `correct horse battery` | The one password that unlocks the app. Without it and `NODE_ENV=production`, the server refuses to start. Unset in dev = no login. |
| `SESSION_SECRET` | Yes when `OWNER_PASSWORD` is set | output of `openssl rand -hex 32` | Signs the login cookie. Changing it logs everyone out. |
| `DATABASE_URL` | Yes for cloud / home lab | `postgres://user:pw@host/neondb?sslmode=verify-full` | Postgres for the track list; tables are created automatically on start. Unset = a local `data/tracks.json` file (dev only). |
| `S3_BUCKET` | Yes for cloud / home lab | `ttunes` | Bucket holding the audio. Unset = files on local disk in `uploads/` (dev only). |
| `S3_ENDPOINT` | Yes with R2 / MinIO | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | S3 API address. |
| `S3_ACCESS_KEY_ID` | Yes with R2 / MinIO | from the R2 token | Storage key ID. Must be set together with the secret. |
| `S3_SECRET_ACCESS_KEY` | Yes with R2 / MinIO | from the R2 token | Storage secret. |
| `S3_REGION` | No (default `auto`) | `auto` | `auto` for R2. Only real AWS S3 needs a real region. |
| `S3_FORCE_PATH_STYLE` | No (default `true`) | `true` | Path-style bucket URLs; right for R2 and MinIO. |
| `COOKIE_SECURE` | No (default: on when `NODE_ENV=production`) | `true` | Marks the login cookie HTTPS-only. Set `false` only for plain-http local use. |
| `TRUST_PROXY` | Yes behind a proxy | `1` | How many proxies sit in front (Fly: 1). Makes the wrong-password lockout see real client IPs instead of the proxy's. |
| `PORT` | No (image default `8080`) | `8080` | Port the server listens on. |
| `NODE_ENV` | No (image default `production`) | `production` | Production mode: password required, secure cookie by default. |
| `STATIC_DIR` | No | `/app/dist` | Folder of the built web app to serve. Default: `dist/` next to the server, if it has been built. |

Compose-only knobs (`docker-compose.yml`): `TTUNES_PORT` (host port, default 18080),
`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (the bundled database and
storage credentials; change them on a real server), `TTUNES_IMAGE` (image tag).

## Checks that guard every push

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, front-end build,
and every test against a real Postgres and MinIO (it fails if any test is skipped), then
builds the image and runs `scripts/smoke.sh`, which starts the whole compose stack, logs in,
uploads a short generated WAV and plays it back with a Range request.
