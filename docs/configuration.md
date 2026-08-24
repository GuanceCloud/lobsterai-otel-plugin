# Configuration

The plugin has two enable switches: OpenClaw must load the installed entry, and plugin config `enabled` must be `true`. Telemetry is opt-in; the config default is `false`.

OpenClaw also requires this host-level trust policy because the plugin consumes raw lifecycle content:

```json
{
  "plugins": {
    "allow": ["lobsterai-otel-plugin"],
    "entries": {
      "lobsterai-otel-plugin": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": false
        }
      }
    }
  }
}
```

This permission is outside `pluginConfig`. It only grants this plugin read access to the lifecycle events it instruments; prompt mutation stays blocked.

## GTrace profile

```json
{
  "enabled": true,
  "profile": "gtrace",
  "endpoint": "https://llm-openway.guance.com",
  "xToken": "<workspace-token>",
  "captureContent": "preview",
  "resourceAttributes": {
    "deployment.environment.name": "production",
    "service.version": "2026.8.19"
  }
}
```

Default routes are `/v1/write/otel-llm` for traces and `/v1/write/otel-metrics` for metrics. The plugin sets `To-Headless: true` and `X-Token` when configured.

## Standard OTLP profile

```json
{
  "enabled": true,
  "profile": "otlp",
  "endpoint": "http://127.0.0.1:4318",
  "headers": {
    "Authorization": "Bearer <collector-token>"
  },
  "captureContent": "none"
}
```

Default standard routes are `/v1/traces` and `/v1/metrics`. `tracesUrl` and `metricsUrl` can override complete signal URLs; `tracePath` and `metricsPath` override only the path.

## Environment fallback

Plugin configuration wins over these environment values:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_TIMEOUT`
- `LOBSTERAI_OTEL_STATE_DIR`

Environment headers use the standard comma-separated `key=value` form with percent encoding where required.

## Operational settings

| Field | Default | Meaning |
| --- | --- | --- |
| `captureContent` | `preview` | `none`, cropped/redacted `preview`, or cropped/redacted `full` |
| `maxChars` | 2000 | maximum captured characters per value |
| `timeoutMs` | 25000 | per-request timeout |
| `internalRequestPolicy` | `drop` | drop or export internal maintenance turns |
| `debug` | false | success summaries without secret/payload logging |

Retry interval, lock TTL, retention and state path have safe internal defaults and may be supplied in configuration for tests/advanced deployments even though LobsterAI does not expose them as primary UI fields.

## Installer merge behavior

Release installers update only explicitly supplied telemetry fields. Re-running an installer without `--x-token`/`-XToken`, for example, preserves the current token. Repeated `--header`/`-Header` and `--tag`/`-Tag` values merge into the existing maps instead of replacing unrelated keys. Use `--no-config` or `-NoConfig` to skip all private telemetry changes; plugin registration and the required read-only Hook trust policy are still verified.
