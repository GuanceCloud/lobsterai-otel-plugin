#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${LOBSTERAI_OTEL_REPOSITORY:-GuanceCloud/lobsterai-otel-plugin}"
VERSION="${LOBSTERAI_OTEL_VERSION:-latest}"

usage() {
  cat <<'HELP'
Usage: install-release.sh [latest|vX.Y.Z|X.Y.Z] [install options]

Examples:
  bash install-release.sh latest --type gtrace --endpoint https://llm-openway.guance.com --x-token TOKEN --enable
  bash install-release.sh v0.1.0 --no-config

All remaining options are passed unchanged to install.sh. Run with --help after
a version to see the core installer options.
HELP
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
  VERSION="$1"
  shift
fi
if [ "$VERSION" != latest ]; then
  VERSION="v${VERSION#v}"
  if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Version must be latest or vX.Y.Z." >&2
    exit 2
  fi
fi

command -v curl >/dev/null 2>&1 || { echo "Missing required command: curl" >&2; exit 1; }
if [ "$VERSION" = latest ]; then
  ASSET="lobsterai-otel-plugin.tar.gz"
  BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
  EXPECTED_VERSION=""
else
  ASSET="lobsterai-otel-plugin-${VERSION}.tar.gz"
  BASE_URL="https://github.com/$REPOSITORY/releases/download/$VERSION"
  EXPECTED_VERSION="${VERSION#v}"
fi

ARCHIVE_URL="${LOBSTERAI_OTEL_ARCHIVE_URL:-$BASE_URL/$ASSET}"
CHECKSUM_URL="${LOBSTERAI_OTEL_CHECKSUM_URL:-$BASE_URL/$ASSET.sha256}"
INSTALLER_URL="${LOBSTERAI_OTEL_INSTALL_URL:-$BASE_URL/install.sh}"
INSTALLER_CHECKSUM_URL="${LOBSTERAI_OTEL_INSTALL_CHECKSUM_URL:-$BASE_URL/install.sh.sha256}"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lobsterai-otel-release.XXXXXX")"
cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT INT TERM

curl -fsSL "$ARCHIVE_URL" -o "$TEMP_DIR/$ASSET"
curl -fsSL "$CHECKSUM_URL" -o "$TEMP_DIR/$ASSET.sha256"
curl -fsSL "$INSTALLER_URL" -o "$TEMP_DIR/install.sh"
curl -fsSL "$INSTALLER_CHECKSUM_URL" -o "$TEMP_DIR/install.sh.sha256"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}
verify() {
  local file="$1" checksum="$2" expected actual
  expected="$(awk 'NR==1 {print $1}' "$checksum" | tr '[:upper:]' '[:lower:]')"
  actual="$(sha256_file "$file" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Checksum verification failed for $(basename "$file")." >&2
    exit 1
  fi
}
verify "$TEMP_DIR/$ASSET" "$TEMP_DIR/$ASSET.sha256"
verify "$TEMP_DIR/install.sh" "$TEMP_DIR/install.sh.sha256"

chmod 700 "$TEMP_DIR/install.sh"
if [ -n "$EXPECTED_VERSION" ]; then
  "$TEMP_DIR/install.sh" --package "$TEMP_DIR/$ASSET" --expected-version "$EXPECTED_VERSION" "$@"
else
  "$TEMP_DIR/install.sh" --package "$TEMP_DIR/$ASSET" "$@"
fi
