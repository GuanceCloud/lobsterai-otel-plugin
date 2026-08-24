# Privacy and security

## Defaults

- Installation does not start telemetry; `enabled` must be explicitly set to `true`.
- OpenClaw requires an explicit per-plugin conversation-read permission; prompt injection remains explicitly disabled.
- Content capture defaults to a redacted, cropped preview. Use `none` for production systems containing sensitive prompts or tool results.
- Authorization, cookie, secret, token, password, API key, private key, client secret, and X-Token keys are recursively replaced.
- Bearer tokens, common provider token prefixes, inline secret assignments, and PEM private keys are redacted from text.
- Tool arguments/results and skill paths are omitted when capture is `none`.
- Error reasons follow the same capture/redaction policy; low-cardinality `error.type` remains.

## What is exported

Trace structure, timing, provider/model, final status, tool/explicit skill names, token usage, and configured low-cardinality resource attributes are exported. Prompt/output preview fields depend on `captureContent`.

Default metrics never include session/run/request identifiers, paths, commands, prompts, content, URLs, or results.

## Credentials

Prefer the LobsterAI plugin configuration UI, which marks `xToken` sensitive. Never commit a real token to this repository. Export logs do not print headers, endpoint URLs, bodies, or tokens.

## Local state

Pending Protobuf payloads are stored in the LobsterAI user profile with mode `0700` directories and `0600` files where the platform supports POSIX permissions. They are deleted after both signals upload successfully; completed tombstones expire after the retention window.
