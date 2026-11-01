#!/bin/bash
# Double-click launcher: builds if needed, starts the server, opens the browser.
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
URL="http://localhost:$PORT"

pause_and_exit() {
  echo
  read -r -p "Press Enter to close this window. "
  exit "${1:-1}"
}

open_browser() {
  [ "${TTUNES_NO_OPEN:-}" = "1" ] || open "$URL"
}

ttunes_is_running() {
  curl -fs "$URL/api/tracks" 2>/dev/null | grep -q '^\['
}

wait_then_open() {
  for _ in $(seq 1 60); do
    if ttunes_is_running; then
      open_browser
      return
    fi
    sleep 0.5
  done
}

needs_build() {
  [ ! -f dist/index.html ] && return 0
  [ -n "$(find src index.html vite.config.ts -newer dist/index.html 2>/dev/null | head -1)" ]
}

if ttunes_is_running; then
  echo "TTunes is already running. Opening it in your browser."
  open_browser
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install it by pasting this into Terminal, then double-click again:"
  echo "  brew install node"
  pause_and_exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing TTunes (takes a minute)..."
  npm ci || { echo "Install failed."; pause_and_exit 1; }
fi

if needs_build; then
  echo "Building the TTunes screen..."
  npm run build || { echo "Build failed."; pause_and_exit 1; }
fi

for tool in yt-dlp ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "WARNING: $tool is missing. Adding songs from YouTube will not work until you install it."
    echo "  Paste this into Terminal:  brew install yt-dlp ffmpeg"
  fi
done

wait_then_open &
echo "TTunes is running at $URL — close this window to stop."
PORT="$PORT" npm start
echo
echo "TTunes stopped."
pause_and_exit 0
