# LobsterAI OTel Plugin Instructions

This repository implements a LobsterAI/OpenClaw lifecycle plugin that exports GTrace-compatible OTLP/HTTP Protobuf traces and metrics.

- Keep runtime behavior fail-open. Telemetry failures must never block LobsterAI.
- A turn is exported only after a terminal `agent_end` event.
- Trace roots are `invoke_agent`; `llm`, `tool:*`, and `assistant` are direct children. A `skill:*` span is allowed only under the matching tool span when a Skill invocation or `SKILL.md` path is explicit.
- Metrics are derived from the exact spans exported for a terminal turn. The only default metrics are `gen_ai.workflow.duration`, `gen_ai.agent.operation.count`, `gen_ai.agent.operation.duration`, and `gen_ai.client.token.usage`.
- Never put session/run identifiers, prompts, outputs, paths, commands, results, URLs, or stack traces in resource attributes or metric attributes.
- Never commit real prompts, transcripts, tokens, cookies, authorization values, customer endpoints, or usernames. Fixtures must be synthetic.
- Preserve per-signal retry state: trace success and metric success are marked independently, and a turn is completed only after both succeed.
- Installer tests must use temporary LobsterAI data roots and must not alter the real user profile.

Before delivery run:

```bash
npm test
npm run check
npm ls --all
```
