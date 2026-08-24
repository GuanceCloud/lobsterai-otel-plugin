# LobsterAI product research

Research date: 2026-08-21 (Asia/Shanghai)

## Scope and evidence

This research inspected the locally installed `/Applications/LobsterAI.app` read-only. No message, credential, or account value was copied. The SQLite inspection was limited to schema names. Synthetic fixtures in this repository contain no user data.

| Item | Observed value | Evidence |
| --- | --- | --- |
| LobsterAI | 2026.8.19, Electron application | macOS application metadata and packaged `app.asar` |
| Embedded runtime | OpenClaw v2026.6.1, commit `2e08f0f4221f522b60423ed6ffd83427942b28de` | packaged `cfmind/runtime-info.json` and exact upstream source checkout |
| Plugin manifest | `openclaw.plugin.json` | bundled PluginManager and OpenClaw plugin SDK |
| Supported install sources | ClawHub, npm, Git, local | LobsterAI PluginManager source enum and UI copy |
| User plugin storage | `third-party-extensions`, plus OpenClaw state extensions | bundled PluginManager discovery paths |
| Runtime config | `<LobsterAI user data>/openclaw/state/openclaw.json` | LobsterAI config synchronization implementation |
| Long-running host | OpenClaw gateway managed by LobsterAI | packaged gateway manager and plugin service lifecycle |
| Conversation hook policy | explicit `plugins.entries.<id>.hooks.allowConversationAccess=true` | embedded OpenClaw host-level gateway validation |

The local application database includes plugin metadata/config tables (`user_plugins`) and agent/session tables. This plugin deliberately does not poll or read those tables: native lifecycle hooks are more precise and avoid coupling to private database schema.

## Plugin loading and configuration

LobsterAI can install a Git repository from the Plugins screen. It stages the source, packages/installs it through its bundled OpenClaw runtime, publishes it under the user plugin area, stores enable/config state, adds the plugin load path/allow entry, and synchronizes OpenClaw configuration. A gateway restart is required when the installed code or startup configuration changes.

The schema in `openclaw.plugin.json` is rendered by LobsterAI. Fields whose names imply keys, tokens, secrets, or passwords are treated as sensitive; this project also marks `xToken` explicitly sensitive.

OpenClaw blocks raw conversation hooks from non-bundled plugins even when the plugin itself is enabled. The operator must separately grant `allowConversationAccess=true`. The release installers apply that narrow permission and explicitly keep `allowPromptInjection=false`; Git/UI installation requires the same one-time host-policy setting.

## Lifecycle and correlation

The exact embedded OpenClaw source confirms that `runId` is a per-turn UUID and remains stable across model iterations and retries. `sessionKey`/`sessionId` is stable at the conversation level. Tool and model call IDs provide exact child-operation correlation.

LobsterAI's UI can create the session transcript before the first agent run. In that path OpenClaw may not emit `session_start` for the first prompt even though the transcript begins with a `type=session` record containing the actual session ID and creation timestamp. The plugin uses that first record as the session-time fallback. At terminal export it also streams only assistant records in the current turn's bounded time window because model hooks do not expose per-call output or usage. It never logs or copies the raw transcript, requires the header session ID to match, rejects unsafe session/agent path segments and symlinks below the state root, and treats oversized, malformed, ambiguous or unmatched input as optional enrichment failure.

| Product event | Use in this plugin |
| --- | --- |
| `session_start` | capture the product-observed session creation time and correlate both session ID aliases |
| `before_agent_run` | start turn, prompt/channel metadata |
| `llm_input`, `model_call_started` | create/correlate LLM operations |
| `model_call_ended`, `llm_output` | exact call duration/outcome; run-level final output and aggregate usage |
| same-session transcript assistant records | per-call provider/model, structured output, finish reason and normalized usage, matched by hook end time |
| `before_tool_call`, `after_tool_call` | tool call boundaries and explicit skill evidence |
| `subagent_spawned` | explicit parent run/session relationship |
| `agent_end` | only terminal authority; build and durably persist telemetry |
| `session_end` | remove cached session metadata; not treated as turn completion |

`agent_end(success=false)` without a prompt error is an aborted/cancelled turn in this OpenClaw version. An error string is classified into a low-cardinality type. Metrics are emitted only after terminal evidence.

## Architecture decision

Selected architecture: native in-process lifecycle hooks with direct OTLP/HTTP Protobuf export.

Why:

- It has exact terminal, LLM and tool boundaries, plus per-call output/usage evidence from a bounded same-session transcript window.
- It does not scrape logs or read private chat database rows.
- It can preserve one trace tree per terminal run.
- A local durable queue makes retry independent for traces and metrics.
- The hook handler returns immediately at terminal time; network I/O is background work.

Rejected alternatives:

- SQLite polling: private schema coupling, weaker terminal semantics, and additional privacy exposure.
- Log tailing: lossy correlation and format instability.
- Sidecar-only interception: cannot reliably reconstruct tools/skills or final status.

## Compatibility matrix

| Platform/product | Status | Notes |
| --- | --- | --- |
| macOS LobsterAI 2026.8.19 / OpenClaw 2026.6.1 | Verified locally | hooks, package installation and load tested with an isolated state directory |
| Windows LobsterAI | Installer implemented, not locally verified | runtime paths are detected or can be supplied explicitly |
| Linux LobsterAI | Manual-path support, not locally verified | pass runtime and OpenClaw entry paths to `install.sh` |
| Newer LobsterAI/OpenClaw | Expected but not asserted | CI covers plugin logic; repeat isolated host smoke test before release |

## Residual risks

- LobsterAI and OpenClaw plugin APIs may change; the manifest and hook names should be retested against each bundled runtime update.
- A hard process termination can leave an active, non-terminal in-memory turn; no telemetry is emitted for it by design.
- `captureContent=full` increases privacy and payload risk. The default is `preview`; `none` is recommended for sensitive environments.
- Transcript enrichment is intentionally conservative: timestamp-ambiguous, missing, malformed, overflowed or unmatched assistant records leave the affected LLM span with hook-only fields rather than guessing.
- A separately installed generic OpenClaw diagnostics/OTel plugin can produce duplicate telemetry. Run only one agent telemetry exporter for the same gateway.
