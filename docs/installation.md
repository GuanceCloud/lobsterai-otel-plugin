# Installation and rollback

## Recommended: LobsterAI Git installation

1. Quit or stop the LobsterAI gateway before changing plugin code.
2. Open LobsterAI **Settings > Plugins** and choose **Install**.
3. Select **Git**, enter `https://github.com/GuanceCloud/lobsterai-otel-plugin`, and install.
4. In LobsterAI's advanced OpenClaw configuration, add the plugin ID to `plugins.allow`, then set `plugins.entries.lobsterai-otel-plugin.hooks.allowConversationAccess=true` and `allowPromptInjection=false`. The exact JSON is in [configuration](configuration.md).
5. Open **LobsterAI OpenTelemetry** configuration. Set `enabled=true`, choose `gtrace` or `otlp`, enter the endpoint/token, and choose the content policy.
6. Restart the gateway from LobsterAI.
7. Run one synthetic or non-sensitive prompt and confirm one `invoke_agent` trace plus the expected metrics at the receiver.

If Git installation is unavailable in a future UI, download a release package and use the installer below.

## macOS/Linux release installer

Download `install-release.sh` from a release, inspect it, then run:

```bash
bash install-release.sh
```

It downloads the latest package and checksum, verifies SHA-256, finds the LobsterAI bundled OpenClaw runtime, and installs into LobsterAI's OpenClaw state. It refuses to touch the default profile while LobsterAI is running. Linux installations with nonstandard paths can pass `--lobsterai-bin` and `--openclaw-entry`.

The release installer also adds the plugin to the host allowlist and grants only the required conversation-read hook permission. It keeps prompt injection disabled.

For a local checkout:

```bash
./install.sh --package .
```

## Windows release installer

Download and inspect `install-release.ps1`, then run it from PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-release.ps1
```

Pass `-LobsterAiBin`, `-OpenClawEntry`, or `-StateDir` if LobsterAI uses nonstandard paths.

## Verify

The gateway log should contain:

```text
[lobsterai-otel] lifecycle hooks enabled; terminal OTLP trace and metric export ready
```

With `debug=true`, successful signal byte counts are logged. Network failures are reported as deferred exports and retried; credentials and payload bodies are not logged.

If the gateway reports that `llm_input`, `llm_output`, `before_agent_run`, or `agent_end` was blocked, the host-level `allowConversationAccess` policy was not applied. Re-run the release installer or apply the JSON in [configuration](configuration.md).

## Rollback

1. Set plugin config `enabled=false` and restart the gateway.
2. Uninstall **LobsterAI OpenTelemetry** from LobsterAI Plugins (preferred), or use the bundled OpenClaw `plugins uninstall lobsterai-otel-plugin` command.
3. Keep the plugin state directory until any desired pending data is no longer needed. It can then be removed manually from `<OpenClaw state>/plugin-data/lobsterai-otel-plugin`.

Rollback does not modify LobsterAI conversations, agents, credentials, or other plugins.
