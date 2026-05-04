#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DIST_DIR="$(pwd)/dist"

# 1. Install dependencies
npm install

# 2. Build extension
npm run build

# 3. Find a compatible browser binary
# Chrome 137+ removed --load-extension support; need Chrome for Testing or Chromium
BROWSER=""

if [[ -x "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ]]; then
  BROWSER="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
elif [[ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]]; then
  BROWSER="/Applications/Chromium.app/Contents/MacOS/Chromium"
else
  # Try Playwright's bundled Chromium (glob for latest version)
  PW_CHROMIUM=$(ls -d "$HOME/Library/Caches/ms-playwright/chromium-"*/chrome-mac/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | sort -V | tail -1 || true)
  if [[ -n "$PW_CHROMIUM" && -x "$PW_CHROMIUM" ]]; then
    BROWSER="$PW_CHROMIUM"
  fi
fi

if [[ -z "$BROWSER" ]]; then
  echo "ERROR: No compatible browser found." >&2
  echo "Chrome 137+ removed --load-extension. Install Chrome for Testing:" >&2
  echo "  npx @puppeteer/browsers install chrome@stable" >&2
  exit 1
fi

echo "Using browser: $BROWSER"

# 4. Launch with extension loaded
exec "$BROWSER" \
  --user-data-dir=/tmp/randbats-bot-profile \
  --disable-extensions-except="$DIST_DIR" \
  --load-extension="$DIST_DIR" \
  "https://play.pokemonshowdown.com"
