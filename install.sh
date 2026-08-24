#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PACKAGE_PATH="$SCRIPT_DIR"
ALLOW_RUNNING=0
CUSTOM_STATE_DIR=""
LOBSTERAI_BIN=""
OPENCLAW_ENTRY=""

usage() {
  echo "Usage: ./install.sh [--package PATH] [--state-dir PATH] [--allow-running]"
  echo "                    [--lobsterai-bin PATH] [--openclaw-entry PATH]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) PACKAGE_PATH="${2:?missing value for --package}"; shift 2 ;;
    --state-dir) CUSTOM_STATE_DIR="${2:?missing value for --state-dir}"; shift 2 ;;
    --allow-running) ALLOW_RUNNING=1; shift ;;
    --lobsterai-bin) LOBSTERAI_BIN="${2:?missing value for --lobsterai-bin}"; shift 2 ;;
    --openclaw-entry) OPENCLAW_ENTRY="${2:?missing value for --openclaw-entry}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    LOBSTERAI_BIN="${LOBSTERAI_BIN:-/Applications/LobsterAI.app/Contents/MacOS/LobsterAI}"
    OPENCLAW_ENTRY="${OPENCLAW_ENTRY:-/Applications/LobsterAI.app/Contents/Resources/cfmind/openclaw.mjs}"
    DEFAULT_STATE_DIR="$HOME/Library/Application Support/LobsterAI/openclaw/state"
    ;;
  Linux)
    : "${LOBSTERAI_BIN:=}"
    : "${OPENCLAW_ENTRY:=}"
    DEFAULT_STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/LobsterAI/openclaw/state"
    ;;
  *) echo "Unsupported platform; use install-release.ps1 on Windows." >&2; exit 1 ;;
esac

STATE_DIR="${CUSTOM_STATE_DIR:-$DEFAULT_STATE_DIR}"
if [ -z "$CUSTOM_STATE_DIR" ] && [ "$ALLOW_RUNNING" -ne 1 ] && command -v pgrep >/dev/null 2>&1 && pgrep -x LobsterAI >/dev/null 2>&1; then
  echo "LobsterAI is running. Quit it first, or pass --allow-running only if you accept a restart race." >&2
  exit 1
fi
if [ -z "$LOBSTERAI_BIN" ] || [ ! -x "$LOBSTERAI_BIN" ]; then
  echo "LobsterAI runtime not found. Pass --lobsterai-bin PATH." >&2
  exit 1
fi
if [ -z "$OPENCLAW_ENTRY" ] || [ ! -f "$OPENCLAW_ENTRY" ]; then
  echo "LobsterAI OpenClaw entry not found. Pass --openclaw-entry PATH." >&2
  exit 1
fi
if [ ! -e "$PACKAGE_PATH" ]; then
  echo "Plugin package not found: $PACKAGE_PATH" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lobsterai-otel-install.XXXXXX")"
cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT INT TERM

INSTALL_SOURCE="$PACKAGE_PATH"
if [ -d "$PACKAGE_PATH" ]; then
  PACK_JSON="$(npm pack "$PACKAGE_PATH" --pack-destination "$TEMP_DIR" --json)"
  PACK_NAME="$(printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].filename))')"
  INSTALL_SOURCE="$TEMP_DIR/$PACK_NAME"
fi

mkdir -p "$STATE_DIR"
echo "Installing into isolated OpenClaw state: $STATE_DIR"
ELECTRON_RUN_AS_NODE=1 OPENCLAW_STATE_DIR="$STATE_DIR" \
  "$LOBSTERAI_BIN" "$OPENCLAW_ENTRY" plugins install "$INSTALL_SOURCE" --force

# OpenClaw intentionally blocks raw conversation lifecycle hooks for every
# non-bundled plugin until the operator grants this per-plugin permission.
ELECTRON_RUN_AS_NODE=1 OPENCLAW_STATE_DIR="$STATE_DIR" \
  "$LOBSTERAI_BIN" "$OPENCLAW_ENTRY" config set \
  plugins.entries.lobsterai-otel-plugin.hooks \
  '{"allowConversationAccess":true,"allowPromptInjection":false}' --strict-json

ALLOW_JSON="$(ELECTRON_RUN_AS_NODE=1 OPENCLAW_STATE_DIR="$STATE_DIR" \
  "$LOBSTERAI_BIN" "$OPENCLAW_ENTRY" config get plugins.allow --json 2>/dev/null || true)"
if [ -z "$ALLOW_JSON" ] || [ "$(printf '%s' "$ALLOW_JSON" | tr -d '[:space:]')" = "[]" ]; then
  ELECTRON_RUN_AS_NODE=1 OPENCLAW_STATE_DIR="$STATE_DIR" \
    "$LOBSTERAI_BIN" "$OPENCLAW_ENTRY" config set plugins.allow \
    '["lobsterai-otel-plugin"]' --strict-json
fi

echo "Installed lobsterai-otel-plugin. It remains telemetry-disabled until configured."
echo "In LobsterAI, open Settings > Plugins > LobsterAI OpenTelemetry, set enabled=true, endpoint/token, then restart the gateway."
