#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="lobsterai-otel-plugin"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PACKAGE_PATH="$SCRIPT_DIR"
EXPECTED_VERSION=""
ALLOW_RUNNING=0
CUSTOM_STATE_DIR=""
LOBSTERAI_BIN=""
OPENCLAW_ENTRY=""
NO_CONFIG=0
PROFILE=""
ENDPOINT=""
X_TOKEN=""
TRACE_PATH=""
METRICS_PATH=""
TRACES_URL=""
METRICS_URL=""
CAPTURE_CONTENT=""
MAX_CHARS=""
TIMEOUT_MS=""
ENABLED=""
DEBUG=""
HEADERS=()
TAGS=()

usage() {
  cat <<'HELP'
Usage: install.sh [options]

Package and host options:
  --package PATH               Package directory or release archive.
  --expected-version X.Y.Z     Require package and manifest version alignment.
  --state-dir PATH             Override LobsterAI OpenClaw state directory.
  --lobsterai-bin PATH         Override the LobsterAI executable.
  --openclaw-entry PATH        Override the bundled openclaw.mjs entry.
  --allow-running              Bypass the running-app safety check.

Telemetry options (only explicit values overwrite existing configuration):
  --type, --profile gtrace|otlp
  --endpoint URL               Base receiver endpoint.
  --x-token TOKEN              GTrace workspace token (never printed).
  --trace-path PATH            Relative trace route.
  --metrics-path PATH          Relative metrics route.
  --traces-url URL             Complete trace URL override.
  --metrics-url URL            Complete metrics URL override.
  --header KEY=VALUE           Merge a request header; repeatable.
  --tag KEY=VALUE              Merge a resource attribute; repeatable.
  --capture-content MODE       none, preview, or full.
  --max-chars NUMBER           Maximum captured characters.
  --timeout-ms NUMBER          Per-request timeout.
  --enable | --disable         Enable or disable telemetry collection.
  --debug | --no-debug         Enable or disable safe debug summaries.
  --no-config                  Do not change private telemetry configuration.

The installer always verifies plugin registration and grants the required
conversation-read Hook permission while keeping prompt injection disabled.
HELP
}

need_value() {
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
    echo "Missing value for $1" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) need_value "$@"; PACKAGE_PATH="$2"; shift 2 ;;
    --expected-version) need_value "$@"; EXPECTED_VERSION="${2#v}"; shift 2 ;;
    --state-dir) need_value "$@"; CUSTOM_STATE_DIR="$2"; shift 2 ;;
    --allow-running) ALLOW_RUNNING=1; shift ;;
    --lobsterai-bin) need_value "$@"; LOBSTERAI_BIN="$2"; shift 2 ;;
    --openclaw-entry) need_value "$@"; OPENCLAW_ENTRY="$2"; shift 2 ;;
    --type|--profile) need_value "$@"; PROFILE="$2"; shift 2 ;;
    --endpoint) need_value "$@"; ENDPOINT="$2"; shift 2 ;;
    --x-token) need_value "$@"; X_TOKEN="$2"; shift 2 ;;
    --trace-path) need_value "$@"; TRACE_PATH="$2"; shift 2 ;;
    --metrics-path) need_value "$@"; METRICS_PATH="$2"; shift 2 ;;
    --traces-url) need_value "$@"; TRACES_URL="$2"; shift 2 ;;
    --metrics-url) need_value "$@"; METRICS_URL="$2"; shift 2 ;;
    --header) need_value "$@"; HEADERS+=("$2"); shift 2 ;;
    --tag|--resource-attribute) need_value "$@"; TAGS+=("$2"); shift 2 ;;
    --capture-content) need_value "$@"; CAPTURE_CONTENT="$2"; shift 2 ;;
    --max-chars) need_value "$@"; MAX_CHARS="$2"; shift 2 ;;
    --timeout-ms) need_value "$@"; TIMEOUT_MS="$2"; shift 2 ;;
    --enable) ENABLED=true; shift ;;
    --disable) ENABLED=false; shift ;;
    --debug) DEBUG=true; shift ;;
    --no-debug) DEBUG=false; shift ;;
    --no-config) NO_CONFIG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PROFILE" in ""|gtrace|otlp) ;; *) echo "--type/--profile must be gtrace or otlp" >&2; exit 2 ;; esac
case "$CAPTURE_CONTENT" in ""|none|preview|full) ;; *) echo "--capture-content must be none, preview, or full" >&2; exit 2 ;; esac
case "$MAX_CHARS" in "") ;; *[!0-9]*) echo "--max-chars must be an integer" >&2; exit 2 ;; esac
case "$TIMEOUT_MS" in "") ;; *[!0-9]*) echo "--timeout-ms must be an integer" >&2; exit 2 ;; esac
if [ "${#HEADERS[@]}" -gt 0 ]; then
  for pair in "${HEADERS[@]}"; do
    case "$pair" in *=*) [ -n "${pair%%=*}" ] || { echo "KEY=VALUE key cannot be empty" >&2; exit 2; } ;; *) echo "Expected KEY=VALUE: $pair" >&2; exit 2 ;; esac
  done
fi
if [ "${#TAGS[@]}" -gt 0 ]; then
  for pair in "${TAGS[@]}"; do
    case "$pair" in *=*) [ -n "${pair%%=*}" ] || { echo "KEY=VALUE key cannot be empty" >&2; exit 2; } ;; *) echo "Expected KEY=VALUE: $pair" >&2; exit 2 ;; esac
  done
fi

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
if [ "$ALLOW_RUNNING" -ne 1 ]; then
  if [ "${LOBSTERAI_OTEL_FORCE_RUNNING:-0}" = 1 ] || { command -v pgrep >/dev/null 2>&1 && pgrep -x LobsterAI >/dev/null 2>&1; }; then
    echo "LobsterAI is running. Quit it first, or pass --allow-running only if you accept a restart race." >&2
    exit 1
  fi
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

run_json_node() {
  if command -v node >/dev/null 2>&1; then
    command node "$@"
  else
    ELECTRON_RUN_AS_NODE=1 "$LOBSTERAI_BIN" "$@"
  fi
}

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lobsterai-otel-install.XXXXXX")"
cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT INT TERM

run_cli() {
  ELECTRON_RUN_AS_NODE=1 OPENCLAW_STATE_DIR="$STATE_DIR" \
    "$LOBSTERAI_BIN" "$OPENCLAW_ENTRY" "$@"
}

INSTALL_SOURCE="$PACKAGE_PATH"
if [ -d "$PACKAGE_PATH" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required when --package points to a directory." >&2
    exit 1
  fi
  PACK_JSON="$(npm pack "$PACKAGE_PATH" --pack-destination "$TEMP_DIR" --json)"
  PACK_NAME="$(printf '%s' "$PACK_JSON" | run_json_node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].filename))')"
  INSTALL_SOURCE="$TEMP_DIR/$PACK_NAME"
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required to validate the plugin archive." >&2
  exit 1
fi
PACKAGE_JSON="$(tar -xOf "$INSTALL_SOURCE" package/package.json 2>/dev/null || true)"
MANIFEST_JSON="$(tar -xOf "$INSTALL_SOURCE" package/openclaw.plugin.json 2>/dev/null || true)"
if [ -z "$PACKAGE_JSON" ] || [ -z "$MANIFEST_JSON" ]; then
  echo "Archive does not contain package/package.json and package/openclaw.plugin.json." >&2
  exit 1
fi
PACKAGE_VERSION="$(PACKAGE_JSON="$PACKAGE_JSON" MANIFEST_JSON="$MANIFEST_JSON" run_json_node -e '
const p=JSON.parse(process.env.PACKAGE_JSON); const m=JSON.parse(process.env.MANIFEST_JSON);
if (p.name !== "lobsterai-otel-plugin" || m.id !== p.name) process.exit(2);
if (!m.version || m.version !== p.version) process.exit(3);
process.stdout.write(p.version);
' 2>/dev/null)" || { echo "Package metadata or manifest version is invalid." >&2; exit 1; }
if [ -n "$EXPECTED_VERSION" ] && [ "$PACKAGE_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Package version $PACKAGE_VERSION does not match requested version $EXPECTED_VERSION." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
echo "Installing lobsterai-otel-plugin v$PACKAGE_VERSION into the selected LobsterAI OpenClaw state directory."
run_cli plugins install "$INSTALL_SOURCE" --force

# Registration and Hook trust are host settings, not private telemetry options.
run_cli config set "plugins.entries.$PLUGIN_ID.enabled" true --strict-json >/dev/null
run_cli config set "plugins.entries.$PLUGIN_ID.hooks" \
  '{"allowConversationAccess":true,"allowPromptInjection":false}' --strict-json --merge >/dev/null

ALLOW_JSON="$(run_cli config get plugins.allow --json 2>/dev/null || printf '[]')"
NEW_ALLOW_JSON="$(ALLOW_JSON="$ALLOW_JSON" run_json_node -e '
let values=[]; try { values=JSON.parse(process.env.ALLOW_JSON || "[]"); } catch {}
if (!Array.isArray(values)) values=[];
if (!values.includes("lobsterai-otel-plugin")) values.push("lobsterai-otel-plugin");
process.stdout.write(JSON.stringify(values));
')"
run_cli config set plugins.allow "$NEW_ALLOW_JSON" --strict-json >/dev/null
run_cli plugins inspect "$PLUGIN_ID" --json >/dev/null

if [ "$NO_CONFIG" -ne 1 ]; then
  HEADERS_JSON='[]'
  TAGS_JSON='[]'
  if [ "${#HEADERS[@]}" -gt 0 ]; then
    HEADERS_JSON="$(printf '%s\n' "${HEADERS[@]}" | run_json_node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split(/\n/).filter(Boolean))));
')"
  fi
  if [ "${#TAGS[@]}" -gt 0 ]; then
    TAGS_JSON="$(printf '%s\n' "${TAGS[@]}" | run_json_node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split(/\n/).filter(Boolean))));
')"
  fi
  CONFIG_PATCH="$(PROFILE="$PROFILE" ENDPOINT="$ENDPOINT" X_TOKEN="$X_TOKEN" TRACE_PATH="$TRACE_PATH" \
    METRICS_PATH="$METRICS_PATH" TRACES_URL="$TRACES_URL" METRICS_URL="$METRICS_URL" \
    CAPTURE_CONTENT="$CAPTURE_CONTENT" MAX_CHARS="$MAX_CHARS" TIMEOUT_MS="$TIMEOUT_MS" \
    ENABLED="$ENABLED" DEBUG="$DEBUG" HEADERS_JSON="$HEADERS_JSON" TAGS_JSON="$TAGS_JSON" \
    run_json_node -e '
const patch={plugins:{entries:{"lobsterai-otel-plugin":{config:{}}}}};
const c=patch.plugins.entries["lobsterai-otel-plugin"].config;
const scalar={profile:"PROFILE",endpoint:"ENDPOINT",xToken:"X_TOKEN",tracePath:"TRACE_PATH",metricsPath:"METRICS_PATH",tracesUrl:"TRACES_URL",metricsUrl:"METRICS_URL",captureContent:"CAPTURE_CONTENT"};
for (const [key,env] of Object.entries(scalar)) if (process.env[env]) c[key]=process.env[env];
for (const [key,env] of [["maxChars","MAX_CHARS"],["timeoutMs","TIMEOUT_MS"]]) if (process.env[env]) c[key]=Number(process.env[env]);
for (const [key,env] of [["enabled","ENABLED"],["debug","DEBUG"]]) if (process.env[env]) c[key]=process.env[env]==="true";
const pairs=(name)=>JSON.parse(process.env[name]||"[]");
const object=(items)=>Object.fromEntries(items.map(v=>{const i=v.indexOf("="); return [v.slice(0,i),v.slice(i+1)];}));
const headers=object(pairs("HEADERS_JSON")); if (Object.keys(headers).length) c.headers=headers;
const tags=object(pairs("TAGS_JSON")); if (Object.keys(tags).length) c.resourceAttributes=tags;
process.stdout.write(JSON.stringify(patch));
')"
  if [ "$CONFIG_PATCH" != '{"plugins":{"entries":{"lobsterai-otel-plugin":{"config":{}}}}}' ]; then
    printf '%s' "$CONFIG_PATCH" | run_cli config patch --stdin >/dev/null
  fi
fi

echo "Installed lobsterai-otel-plugin v$PACKAGE_VERSION. Restart LobsterAI before validation."
echo "Verify the gateway log contains: [lobsterai-otel] lifecycle hooks enabled"
