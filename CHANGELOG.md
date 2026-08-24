# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 - 2026-08-24

- Add LobsterAI/OpenClaw native lifecycle instrumentation.
- Add GTrace semantic trace tree and four derived OTLP metric families.
- Preserve each model call across multi-tool loops and enrich it from bounded same-session transcript records with per-call output and token usage.
- Add OTLP/HTTP Protobuf export with durable, per-signal retry markers.
- Add opt-in capture policies, recursive redaction, and internal-turn filtering.
- Add root-span `session_create_at` and `session_updated_at` from native session lifecycle and transcript-header evidence.
- Add root-only `usage_input_tokens` and `usage_output_tokens` aliases for current Agent Monitoring Session aggregation compatibility.
- Add LobsterAI Git/release installation paths, checksums, tests, and research documentation.
- Add checksum-verified, version-selectable macOS/Linux and Windows release installers with explicit-only configuration merging and isolated installer regression tests.
- Add a tag-gated GitHub Release workflow with version alignment, audit, Windows installer validation, versioned/latest archives, sidecar checksums, and `SHA256SUMS`.
