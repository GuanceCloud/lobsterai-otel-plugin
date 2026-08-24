#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="GuanceCloud/lobsterai-otel-plugin"
BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lobsterai-otel-release.XXXXXX")"
cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT INT TERM

curl -fsSL "$BASE_URL/lobsterai-otel-plugin.tgz" -o "$TEMP_DIR/lobsterai-otel-plugin.tgz"
curl -fsSL "$BASE_URL/lobsterai-otel-plugin.tgz.sha256" -o "$TEMP_DIR/lobsterai-otel-plugin.tgz.sha256"
curl -fsSL "$BASE_URL/install.sh" -o "$TEMP_DIR/install.sh"

EXPECTED="$(awk '{print $1}' "$TEMP_DIR/lobsterai-otel-plugin.tgz.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TEMP_DIR/lobsterai-otel-plugin.tgz" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TEMP_DIR/lobsterai-otel-plugin.tgz" | awk '{print $1}')"
fi
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum verification failed." >&2
  exit 1
fi

chmod 700 "$TEMP_DIR/install.sh"
"$TEMP_DIR/install.sh" --package "$TEMP_DIR/lobsterai-otel-plugin.tgz" "$@"
