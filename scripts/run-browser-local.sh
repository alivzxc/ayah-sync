#!/usr/bin/env bash
# Open an isolated browser profile for CPU-mode testing, without throttling.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="${BROWSER_PATH:-$(command -v brave-browser || command -v chromium || command -v google-chrome || true)}"
if [ -z "$BROWSER" ] || [ ! -f dist/manifest.json ] ||
  [ ! -f dist/models/quran-asr-small/model.int8.onnx ]; then
  echo "Browser or CPU build missing. Export the model and run npm run build first."
  exit 1
fi
echo "Select Recognition → Browser CPU, then Start CPU sync (or disable Auto CPU look-ahead for live-only)."
exec "$BROWSER" \
  --user-data-dir="$ROOT/server/cache/browser-local-profile" \
  --disable-extensions-except="$ROOT/dist" --load-extension="$ROOT/dist" \
  --disable-gpu --no-first-run --no-default-browser-check \
  "${1:-chrome://extensions}"
