#!/bin/bash
# Double-click launcher: builds if needed, starts the server, opens the browser.
cd "$(dirname "$0")" || exit 1

# Finder launches don't load the shell profile, so find Homebrew ourselves.
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"

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

node_is_new_enough() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'
}

needs_install() {
  [ ! -d node_modules ] && return 0
  [ package-lock.json -nt node_modules/.package-lock.json ]
}

needs_build() {
  [ ! -f dist/index.html ] && return 0
  [ -n "$(find src index.html vite.config.ts package-lock.json -newer dist/index.html 2>/dev/null | head -1)" ]
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

if ! node_is_new_enough; then
  echo "Your Node is too old (TTunes needs version 22.12 or newer). Update it by pasting this into Terminal, then double-click again:"
  echo "  brew install node"
  pause_and_exit 1
fi

if needs_install; then
  echo "Installing TTunes (takes a minute)..."
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
