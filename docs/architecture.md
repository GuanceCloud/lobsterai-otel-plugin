# Architecture

## Data flow

```text
LobsterAI desktop
  -> embedded OpenClaw lifecycle hooks
  -> per-run in-memory correlation
  -> terminal agent_end
  -> bounded same-session transcript enrichment for per-call output/usage
  -> GTrace semantic span tree + four derived metric families
  -> OTLP Protobuf payloads persisted under plugin-data
  -> independent traces/metrics upload markers
  -> GTrace OpenWay or a standard OTLP/HTTP receiver
```

There is one trace per terminal `runId`. IDs are deterministic hashes of product correlation IDs, so rebuilding a terminal batch does not produce a second logical trace.

## Span tree

```text
invoke_agent
├── llm
├── tool:<name>
│   └── skill:<name>   (explicit product event or SKILL.md evidence only)
├── llm
└── assistant
```

Every non-skill operation is a direct child of `invoke_agent`; a skill is only a child of the tool that invoked it. The assistant span describes the final output and does not duplicate token usage.

The root span records `session_create_at` from the product's `session_start` hook and `session_updated_at` from the terminal turn time. LobsterAI can create a transcript before OpenClaw decides whether to emit `session_start`; when that hook is absent, the plugin uses the transcript's first `type=session` metadata record. Both values are ISO 8601 timestamps. If neither source is available, it omits the unknown creation time instead of substituting the first observed turn.

OpenClaw's model hooks provide exact call IDs and timing boundaries but expose output and token usage only as a run-level terminal aggregate. Immediately before terminal export, the plugin therefore streams the same session's JSONL transcript and retains only assistant records inside the current turn's small clock/flush-tolerance window. LobsterAI writes the model-call start to the inner `message.timestamp` and the response flush time to the outer record `timestamp`; matching therefore uses the outer timestamp, with the inner value only as a compatibility fallback. Records are matched one-to-one to the uniquely nearest `model_call_ended` timestamp. Matched calls receive provider/model, normalized finish reason, structured reasoning/text/tool-call output, and per-call usage; unmatched calls remain hook-only. Safe path-segment checks, rejection of symlinks below the state root, no-follow open plus file-identity verification, a 64 MiB transcript read ceiling, bounded retained records, recursive redaction/cropping, and fail-open parsing prevent this enrichment from blocking the host or copying a raw transcript into plugin state.

Canonical token usage remains in `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. Each enriched child `llm` span carries its individual canonical usage, while the root continues to prefer OpenClaw's run-level aggregate. Until Agent Monitoring's Session aggregation reads the canonical root fields, the root also carries the compatibility aliases `usage_input_tokens` and `usage_output_tokens`. Child spans never carry those aliases, preventing double counting in session-level sums.

## Metrics

Metrics are derived from the finalized spans and use delta temporality:

| Metric | Type/unit | Source |
| --- | --- | --- |
| `gen_ai.workflow.duration` | histogram, seconds | terminal root span |
| `gen_ai.agent.operation.count` | monotonic delta sum | LLM/tool/skill operations |
| `gen_ai.agent.operation.duration` | histogram, milliseconds | LLM/tool/skill operations |
| `gen_ai.client.token.usage` | histogram, tokens | LLM input/output usage |

Conversation, session, turn, run, request, prompt, path and command values are prohibited from resource attributes and default metric dimensions. They remain available on traces where correlation is required.

OpenClaw reports uncached input and cache-read usage separately. The semantic total input value is `input + cacheRead`; cache-read is also preserved as its own trace attribute.

## Reliability contract

The first terminal batch is serialized and stored before upload. A `claim.lock` serializes concurrent attempts. `traces.json` and `metrics.json` are independent success markers, so a failed metric upload retries the exact original metric payload without resending a successful trace. Completed records are retained briefly as tombstones for duplicate suppression, then cleaned up.

State lives below `<OpenClaw state>/plugin-data/lobsterai-otel-plugin` unless `LOBSTERAI_OTEL_STATE_DIR` is set. Payload files are created with user-only permissions. Logs contain error categories/status only, never endpoints, headers, tokens, or payload bodies.

## Internal traffic and subagents

Heartbeat, title, summary, compaction, review and memory-triggered turns are dropped by default. This is configurable with `internalRequestPolicy=export`.

Subagents receive their own trace when OpenClaw supplies a child run ID. Parent run/session IDs are added as trace attributes only; no guessed distributed parent context is fabricated.
