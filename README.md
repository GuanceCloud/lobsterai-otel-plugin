# LobsterAI OpenTelemetry Plugin

Export LobsterAI agent lifecycle telemetry as GTrace-compatible OpenTelemetry traces and metrics over OTLP/HTTP Protobuf.

[中文说明](README_ZH.md)

## Highlights

- Uses native lifecycle hooks from LobsterAI's embedded OpenClaw runtime; it does not read chat databases or scrape logs.
- Produces one `invoke_agent -> llm/tool/skill/assistant` trace tree per terminal run.
- Emits skill spans only from explicit product events or `SKILL.md` evidence.
- Derives the four standard GTrace metric families for workflow duration, operation count/duration, and token usage.
- Persists the exact Protobuf batch before upload, acknowledges traces and metrics independently, and suppresses duplicates.
- Supports `none`, `preview`, and `full` content policies with recursive credential redaction.
- Is telemetry-disabled after installation until `enabled=true` is explicitly configured.

## Compatibility

Installation and plugin loading have been verified locally against LobsterAI 2026.8.19 with embedded OpenClaw v2026.6.1 (`2e08f0f`). See [product research](docs/product-research.md) for evidence and platform status.

## Install

In LobsterAI, open **Settings > Plugins > Install > Git** and enter:

```text
https://github.com/GuanceCloud/lobsterai-otel-plugin
```

Then configure **LobsterAI OpenTelemetry**:

```json
{
  "enabled": true,
  "profile": "gtrace",
  "endpoint": "https://llm-openway.guance.com",
  "xToken": "<workspace-token>",
  "captureContent": "preview"
}
```

Restart the LobsterAI gateway. Use `profile=otlp` for a standard OTLP/HTTP receiver. See [installation and rollback](docs/installation.md) and [configuration](docs/configuration.md).

For a checksum-verified release install on macOS/Linux:

```bash
curl -fsSLO https://github.com/GuanceCloud/lobsterai-otel-plugin/releases/latest/download/install-release.sh
bash install-release.sh latest --type gtrace --endpoint https://llm-openway.guance.com --x-token '<workspace-token>' --enable
```

Windows PowerShell users can download `install-release.ps1` from the same Release and run it with equivalent `-Version`, `-Type`, `-Endpoint`, `-XToken`, and `-Enable` parameters. Fixed versions such as `v0.1.0` are supported on both platforms.

OpenClaw blocks raw conversation hooks from untrusted third-party plugins. A Git/UI install must also set `plugins.entries.lobsterai-otel-plugin.hooks.allowConversationAccess=true`; the release installers do this automatically while keeping `allowPromptInjection=false`.

## Development

Node.js 22.19 or newer is required.

```bash
npm ci
npm test
npm run check
npm audit --audit-level=moderate
npm run pack:release
```

Tests use only synthetic fixtures. See [architecture](docs/architecture.md) and [privacy](docs/privacy.md) for the telemetry and data-handling contracts.

## License

Apache License 2.0.
