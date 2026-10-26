#!/usr/bin/env bash
# End-to-end smoke test of the container: docker compose (app + Postgres + MinIO) up,
# then /health, the front end, login, upload a generated WAV, play it back with a Range
# request, /api/station if it exists; always tears everything down (volumes too).
# Exits non-zero on the first failure.
#   scripts/smoke.sh                  # builds the image
#   SMOKE_BUILD=0 scripts/smoke.sh    # uses an already-built $TTUNES_IMAGE (default ttunes:local)
set -euo pipefail

cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ttunes-smoke}"
export TTUNES_PORT="${TTUNES_PORT:-18080}"
export OWNER_PASSWORD="smoke-test-password"
export SESSION_SECRET="smoke-test-secret-not-for-production"
BASE="http://127.0.0.1:${TTUNES_PORT}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"

fail() {
  echo "SMOKE FAIL: $*" >&2
  docker compose logs --no-color --tail=100 >&2 || true
  exit 1
}
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ "${SMOKE_BUILD:-1}" = "0" ]; then
  docker compose up -d
else
  docker compose up -d --build
fi

echo "waiting for $BASE/health ..."
for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" = "200" ]; then break; fi
  [ "$i" = 60 ] && fail "/health never returned 200"
  sleep 1
done
echo "ok   /health"

# status <expected> <curl args...>: runs curl, checks the HTTP status, body goes to $WORK/body
status() {
  local want="$1"; shift
  local got
  got="$(curl -s -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || fail "expected $want, got $got for: $* -- body: $(head -c 300 "$WORK/body")"
}

status 200 "$BASE/"
grep -qi '<div id="root">' "$WORK/body" || fail "/ did not serve the front end's index.html"
echo "ok   / serves the front end"

status 401 "$BASE/api/tracks"
echo "ok   /api/tracks is 401 without a session"

status 401 -H 'Content-Type: application/json' -d '{"password":"wrong"}' "$BASE/api/login"
status 204 -c "$JAR" -H 'Content-Type: application/json' -d "{\"password\":\"$OWNER_PASSWORD\"}" "$BASE/api/login"
echo "ok   login (wrong password 401, right password 204)"

# 1 s, 8 kHz, mono, 16-bit 440 Hz tone
python3 - "$WORK/tone.wav" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000)))
PY
SIZE="$(wc -c < "$WORK/tone.wav" | tr -d ' ')"

status 201 -b "$JAR" -F "file=@$WORK/tone.wav;type=audio/wav" "$BASE/api/tracks"
ID="$(grep -o '"id":"[^"]*"' "$WORK/body" | head -1 | cut -d'"' -f4)"
[ -n "$ID" ] || fail "upload response had no id: $(cat "$WORK/body")"
grep -q '"durationSec":1' "$WORK/body" || fail "metadata not read from upload: $(cat "$WORK/body")"
echo "ok   upload -> track $ID ($SIZE bytes)"

status 200 -b "$JAR" "$BASE/api/tracks"
grep -q "\"$ID\"" "$WORK/body" || fail "uploaded track missing from /api/tracks"
echo "ok   track listed (Postgres)"

status 206 -b "$JAR" -H 'Range: bytes=0-99' "$BASE/audio/$ID"
grep -qi "^content-range: bytes 0-99/$SIZE" "$WORK/headers" || fail "bad Content-Range: $(grep -i content-range "$WORK/headers")"
[ "$(wc -c < "$WORK/body" | tr -d ' ')" = 100 ] || fail "206 body was not 100 bytes"
head -c 4 "$WORK/body" | grep -q RIFF || fail "206 body is not the start of the uploaded WAV"
echo "ok   /audio/$ID Range -> 206, 100 bytes (MinIO)"

status 401 "$BASE/audio/$ID"
echo "ok   /audio is 401 without a session"

code="$(curl -s -o "$WORK/body" -w '%{http_code}' -b "$JAR" "$BASE/api/station")"
case "$code" in
  404) echo "skip /api/station (route not in this build)" ;;
  2??) echo "ok   /api/station -> $code" ;;
  *) fail "/api/station returned $code: $(head -c 300 "$WORK/body")" ;;
esac

echo "SMOKE PASS"
