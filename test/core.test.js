import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { deriveMetrics } from "../src/metrics.js";
import { terminalStatus } from "../src/model.js";
import { serializeSignals } from "../src/otlp.js";
import { captureText, sanitizeValue } from "../src/privacy.js";
import { __runtimeTest, createLobsterAiRuntime } from "../src/runtime.js";
import { buildSpanBatch } from "../src/spans.js";
import { __transcriptTest, readAndEnrichTranscript, sessionTranscriptPath } from "../src/transcript.js";

const logger = { info() {}, warn() {}, error() {} };

function sampleTurn(overrides = {}) {
  return {
    runId: "run-synthetic-1",
    sessionId: "session-synthetic-1",
    sessionKey: "agent:main:synthetic",
    channelId: "desktop",
    trigger: "user",
    sessionCreateMs: 1_783_999_940_000,
    startMs: 1_784_000_000_000,
    endMs: 1_784_000_004_000,
    prompt: "Use the demo skill to inspect the synthetic project.",
    llmCalls: [
      {
        callId: "model-call-1",
        startMs: 1_784_000_000_100,
        endMs: 1_784_000_001_000,
        provider: "example",
        model: "model-test",
        responseModel: "model-test",
        output: "I will inspect it.",
        usage: { input: 100, output: 10, cacheRead: 25, reasoningTokens: 3 },
        finishReasons: ["tool_call"],
        ttftMs: 80,
        outcome: "completed"
      },
      {
        callId: "model-call-2",
        startMs: 1_784_000_002_500,
        endMs: 1_784_000_003_600,
        provider: "example",
        model: "model-test",
        output: "Inspection complete.",
        usage: { input: 150, output: 12, cacheRead: 30 },
        finishReasons: ["stop"],
        outcome: "completed"
      }
    ],
    toolCalls: [
      {
        callId: "tool-call-1",
        name: "read",
        startMs: 1_784_000_001_100,
        endMs: 1_784_000_002_300,
        params: { path: "/workspace/.agents/skills/demo/SKILL.md" },
        result: { text: "synthetic skill instructions" },
        skill: { name: "demo", path: "/workspace/.agents/skills/demo/SKILL.md", sourceType: "skill_md" }
      }
    ],
    assistantOutputs: [{ text: "Inspection complete.", timeMs: 1_784_000_003_600 }],
    finalStatus: "completed",
    success: true,
    ...overrides
  };
}

test("config gives plugin values precedence and rejects high-cardinality resource keys", () => {
  const config = resolveConfig({
    profile: "otlp",
    endpoint: "https://plugin.example/otel/",
    xToken: "placeholder-token",
    headers: { Authorization: "Basic placeholder" },
    resourceAttributes: { env: "test", run_id: "forbidden", prompt: "forbidden" }
  }, {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example",
    OTEL_EXPORTER_OTLP_HEADERS: "x-env=present"
  });
  assert.equal(config.tracesUrl, "https://plugin.example/otel/v1/traces");
  assert.equal(config.metricsUrl, "https://plugin.example/otel/v1/metrics");
  assert.equal(config.headers.Authorization, "Basic placeholder");
  assert.equal(config.headers["X-Token"], "placeholder-token");
  assert.equal(config.headers["x-env"], "present");
  assert.equal(config.resourceAttributes.env, "test");
  assert.equal(config.resourceAttributes.run_id, undefined);
  assert.equal(config.resourceAttributes.prompt, undefined);
});

test("plugin export is opt-in", () => {
  assert.equal(resolveConfig({}).enabled, false);
  assert.equal(resolveConfig({ enabled: true }).enabled, true);
});

test("privacy recursively redacts secrets and honors captureContent=none", () => {
  const sanitized = sanitizeValue({
    authorization: "Bearer should-not-survive",
    nested: { password: "hidden", text: "token=abc123456789" }
  }, { maxChars: 2000 });
  assert.equal(sanitized.authorization, "[REDACTED]");
  assert.equal(sanitized.nested.password, "[REDACTED]");
  assert.match(sanitized.nested.text, /\[REDACTED\]/);
  assert.deepEqual(captureText("private prompt", { captureContent: "none", maxChars: 2000 }), { length: 14 });
});

test("span tree and four metric families follow GTrace semantics", () => {
  const config = resolveConfig({ captureContent: "preview", resourceAttributes: { env: "test" } });
  const spans = buildSpanBatch(sampleTurn(), { messages: [] }, config);
  assert.deepEqual(spans.map((span) => span.name), ["invoke_agent", "llm", "llm", "tool:read", "skill:demo", "assistant"]);
  const root = spans[0];
  assert.equal(root.attributes.usage_input_tokens, 305);
  assert.equal(root.attributes.usage_output_tokens, 22);
  assert.equal(root.attributes.session_create_at, "2026-07-14T03:32:20.000Z");
  assert.equal(root.attributes.session_updated_at, "2026-07-14T03:33:24.000Z");
  for (const span of spans.slice(1)) {
    const expectedParent = span.name === "skill:demo"
      ? spans.find((candidate) => candidate.name === "tool:read").spanContext().spanId
      : root.spanContext().spanId;
    assert.equal(span.parentSpanContext.spanId, expectedParent);
    assert.ok(span.startTime[0] >= root.startTime[0]);
    assert.ok(span.endTime[0] <= root.endTime[0]);
  }
  const llm = spans.find((span) => span.name === "llm");
  assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 125);
  assert.equal(llm.attributes.usage_input_tokens, undefined);
  const assistant = spans.find((span) => span.name === "assistant");
  assert.equal(assistant.attributes["gen_ai.usage.input_tokens"], undefined);

  const resourceMetrics = deriveMetrics(spans);
  const names = resourceMetrics.scopeMetrics[0].metrics.map((metric) => metric.descriptor.name);
  assert.deepEqual(names, [
    "gen_ai.workflow.duration",
    "gen_ai.agent.operation.count",
    "gen_ai.agent.operation.duration",
    "gen_ai.client.token.usage"
  ]);
  for (const metric of resourceMetrics.scopeMetrics[0].metrics) {
    for (const point of metric.dataPoints) {
      assert.equal(point.attributes.session_id, undefined);
      assert.equal(point.attributes["gen_ai.conversation.id"], undefined);
    }
  }

  const payloads = serializeSignals(spans, resourceMetrics);
  assert.ok(payloads.traces.length > 100);
  assert.ok(payloads.metrics.length > 100);
  assert.notDeepEqual(payloads.traces, payloads.metrics);
});

test("cancelled and error terminal evidence are distinct", () => {
  assert.equal(terminalStatus({ success: false }).finalStatus, "cancelled");
  assert.equal(terminalStatus({ success: false, error: "request timeout" }).finalStatus, "completed");
  assert.equal(terminalStatus({ success: false, error: "request timeout" }).errorType, "timeout");
});

test("runtime exports a terminal turn once and resumes only the failed signal", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-test-"));
  let currentTime = 1_784_000_000_000;
  const calls = [];
  let failMetrics = true;
  const fetchImpl = async (url, options) => {
    const signal = String(url).includes("metrics") ? "metrics" : "traces";
    calls.push({ signal, body: Buffer.from(options.body), contentType: options.headers["content-type"] });
    if (signal === "metrics" && failMetrics) {
      failMetrics = false;
      return new Response(new Uint8Array(), { status: 503 });
    }
    return new Response(new Uint8Array(), { status: 200 });
  };
  const config = resolveConfig({
    profile: "otlp",
    endpoint: "http://receiver.test",
    captureContent: "none",
    stateDir: temp,
    retryIntervalMs: 600_000
  });
  const runtime = createLobsterAiRuntime({ config, logger, fetchImpl, now: () => currentTime });
  await runtime.start(temp);
  const ctx = { runId: "runtime-run", sessionId: "runtime-session", sessionKey: "agent:main:runtime", trigger: "user" };
  runtime.handlers.onSessionStart({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey }, ctx);
  const sessionCreatedAt = currentTime;
  currentTime += 50;
  runtime.handlers.onBeforeAgentRun({ prompt: "Synthetic user prompt", messages: [] }, ctx);
  currentTime += 100;
  runtime.handlers.onLlmInput({ runId: ctx.runId, sessionId: ctx.sessionId, provider: "example", model: "model-test", prompt: "Synthetic user prompt", historyMessages: [] }, ctx);
  currentTime += 10;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId, callId: "runtime-call", provider: "example", model: "model-test" }, ctx);
  currentTime += 500;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, callId: "runtime-call", provider: "example", model: "model-test", durationMs: 500, outcome: "completed", timeToFirstByteMs: 50 }, ctx);
  runtime.handlers.onLlmOutput({ runId: ctx.runId, sessionId: ctx.sessionId, provider: "example", model: "model-test", assistantTexts: ["Synthetic answer"], usage: { input: 10, output: 2 } }, ctx);
  currentTime += 100;
  const terminalEvent = {
    runId: ctx.runId,
    success: true,
    messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic user prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "Synthetic answer" }] }
    ]
  };
  await runtime.handlers.handleAgentEnd(terminalEvent, ctx);
  assert.deepEqual(calls.map((call) => call.signal), ["traces", "metrics"]);
  assert.ok(calls.every((call) => call.contentType === "application/x-protobuf"));

  await runtime.handlers.handleAgentEnd(terminalEvent, ctx);
  assert.deepEqual(calls.map((call) => call.signal), ["traces", "metrics", "metrics"]);
  assert.deepEqual(calls[2].body, calls[1].body);
  assert.ok(calls[0].body.length > 100);
  assert.ok(calls[2].body.length > 100);
  const turn = runtime.inspect().turns.get(ctx.runId);
  assert.equal(turn, undefined);
  assert.equal(runtime.inspect().sessionMetadata.get(ctx.sessionId).createdAt, sessionCreatedAt);
  runtime.handlers.onSessionEnd({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey }, ctx);
  assert.equal(runtime.inspect().sessionMetadata.size, 0);
  await runtime.stop();
});

test("session hooks populate root lifecycle fields without inventing a missed creation time", () => {
  let currentTime = 1_784_100_000_000;
  const config = resolveConfig({ captureContent: "none" });
  const runtime = createLobsterAiRuntime({ config, logger, now: () => currentTime });
  const registered = new Map();
  runtime.registerHooks({ on(name, handler) { registered.set(name, handler); } });
  assert.ok(registered.has("session_start"));
  assert.ok(registered.has("session_end"));

  const ctx = { runId: "session-run", sessionId: "session-id", sessionKey: "agent:main:session" };
  runtime.handlers.onSessionStart({ sessionId: ctx.sessionId, sessionKey: ctx.sessionKey }, ctx);
  const createdAt = currentTime;
  currentTime += 1_000;
  runtime.handlers.onBeforeAgentRun({ prompt: "Synthetic prompt" }, ctx);
  const observed = runtime.inspect().turns.get(ctx.runId);
  assert.equal(observed.sessionCreateMs, createdAt);

  currentTime += 100;
  const spans = buildSpanBatch({ ...observed, endMs: currentTime, finalStatus: "completed", success: true }, {}, config);
  assert.equal(spans[0].attributes.session_create_at, new Date(createdAt).toISOString());
  assert.equal(spans[0].attributes.session_updated_at, new Date(currentTime).toISOString());

  const missed = sampleTurn({ sessionCreateMs: undefined });
  const missedRoot = buildSpanBatch(missed, {}, config)[0];
  assert.equal(missedRoot.attributes.session_create_at, undefined);
  assert.equal(missedRoot.attributes.session_updated_at, new Date(missed.endMs).toISOString());
});

test("session creation falls back to transcript session metadata", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-session-header-"));
  const sessions = path.join(temp, "agents", "main", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const sessionId = "session-header-test";
  const createdAt = "2026-08-21T09:35:34.610Z";
  await fs.writeFile(path.join(sessions, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionId, timestamp: createdAt, cwd: "/synthetic" }),
    "this deliberately is not valid JSON and must never be parsed"
  ].join("\n"));

  assert.equal(await __runtimeTest.sessionCreateMsFromTranscript(temp, {
    agentId: "main",
    sessionId
  }), Date.parse(createdAt));
  assert.equal(await __runtimeTest.sessionCreateMsFromTranscript(temp, {
    agentId: "../main",
    sessionId
  }), undefined);
  assert.equal(await __runtimeTest.sessionCreateMsFromTranscript(temp, {
    agentId: "main",
    sessionId: "../session-header-test"
  }), undefined);
});

function transcriptTurn(overrides = {}) {
  const startMs = 1_784_400_000_000;
  return {
    ...sampleTurn({
      runId: "transcript-run",
      sessionId: "transcript-session",
      agentId: "main",
      startMs,
      endMs: startMs + 4_000,
      aggregateUsage: { input: 80, cacheRead: 20, output: 12, reasoningTokens: 4 },
      llmCalls: [
        {
          callId: "call-tool-only",
          startMs: startMs + 100,
          endMs: startMs + 1_000,
          model: "request-model-alias",
          outcome: "completed"
        },
        { callId: "call-text-tool", startMs: startMs + 1_200, endMs: startMs + 2_500, outcome: "completed" },
        { callId: "call-final", startMs: startMs + 2_700, endMs: startMs + 3_500, outcome: "completed" }
      ],
      toolCalls: [],
      assistantOutputs: []
    }),
    ...overrides
  };
}

function assistantTranscriptRecord(timestamp, message, messageTimestamp = timestamp) {
  return {
    type: "message",
    id: `message-${timestamp}`,
    parentId: "synthetic-parent",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      timestamp: messageTimestamp,
      provider: "example-provider",
      model: "example-model",
      responseId: `response-${timestamp}`,
      ...message
    }
  };
}

async function writeTranscript(stateDir, sessionId, records) {
  const sessions = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionId, timestamp: "2026-08-24T02:00:00.000Z" }),
    ...records.map((record) => typeof record === "string" ? record : JSON.stringify(record))
  ].join("\n"));
}

test("terminal transcript enriches tool-only, text-and-tool, and final-text LLM calls", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-"));
  const turn = transcriptTurn();
  await writeTranscript(temp, turn.sessionId, [
    assistantTranscriptRecord(turn.llmCalls[0].endMs - 20, {
      content: [
        { type: "thinking", thinking: "Plan the synthetic lookup." },
        { type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "synthetic", apiToken: "must-redact" } }
      ],
      usage: { input: 10, cacheRead: 5, output: 2, reasoningTokens: 1, totalTokens: 17 },
      stopReason: "toolUse"
    }),
    assistantTranscriptRecord(turn.llmCalls[1].endMs - 20, {
      content: [
        { type: "thinking", thinking: "Process the synthetic result." },
        { type: "text", text: "I will run the synthetic formatter." },
        { type: "toolCall", id: "tool-2", name: "format", partialArgs: { value: "synthetic" } }
      ],
      usage: { input: 20, cacheRead: 7, output: 3, reasoningTokens: 2, totalTokens: 32 },
      stopReason: "toolUse"
    }),
    assistantTranscriptRecord(turn.llmCalls[2].endMs - 20, {
      content: [{ type: "text", text: "Synthetic completion." }],
      usage: { input: 40, cacheRead: 4, output: 5, totalTokens: 49 },
      stopReason: "stop"
    })
  ]);

  const config = resolveConfig({ captureContent: "preview" });
  const result = await readAndEnrichTranscript(temp, turn, config);
  assert.equal(result.matched, 3);
  assert.equal(result.finalText, "Synthetic completion.");
  assert.equal(result.sessionCreateMs, Date.parse("2026-08-24T02:00:00.000Z"));
  assert.deepEqual(turn.llmCalls.map((call) => call.finishReasons), [["tool_call"], ["tool_call"], ["stop"]]);
  assert.deepEqual(turn.llmCalls.map((call) => call.outputKind), ["tool_call", "tool_call", "text"]);
  assert.equal(turn.llmCalls[0].output, "tool_call: lookup");
  assert.equal(turn.llmCalls[1].output, "I will run the synthetic formatter.");
  assert.equal(turn.llmCalls[2].output, "Synthetic completion.");
  assert.equal(turn.llmCalls[0].provider, "example-provider");
  assert.equal(turn.llmCalls[0].model, "request-model-alias");
  assert.equal(turn.llmCalls[0].responseModel, "example-model");
  assert.equal(turn.llmCalls[1].model, "example-model");
  assert.equal(turn.llmCalls[0].responseId, `response-${turn.llmCalls[0].endMs - 20}`);

  const spans = buildSpanBatch(turn, {}, config);
  const root = spans[0];
  const llms = spans.filter((span) => span.name === "llm");
  assert.equal(root.durationMs, 4_000);
  assert.deepEqual(llms.map((span) => span.durationMs), [900, 1_300, 800]);
  assert.equal(root.attributes["gen_ai.usage.input_tokens"], 100);
  assert.equal(root.attributes["gen_ai.usage.output_tokens"], 12);
  assert.equal(root.attributes.usage_input_tokens, 100);
  assert.equal(root.attributes.usage_output_tokens, 12);
  assert.deepEqual(llms.map((span) => span.attributes["gen_ai.usage.input_tokens"]), [15, 27, 44]);
  assert.deepEqual(llms.map((span) => span.attributes["gen_ai.usage.output_tokens"]), [2, 3, 5]);
  assert.deepEqual(llms.map((span) => span.attributes.output_kind), ["tool_call", "tool_call", "text"]);
  assert.equal(llms[0].attributes.output_preview, "tool_call: lookup");
  assert.equal(llms[0].attributes["gen_ai.request.model"], "request-model-alias");
  assert.equal(llms[0].attributes["gen_ai.response.model"], "example-model");
  assert.equal(llms[0].attributes["gen_ai.response.id"], `response-${turn.llmCalls[0].endMs - 20}`);

  const toolOnlyMessage = JSON.parse(llms[0].attributes["gen_ai.output.messages"])[0];
  assert.deepEqual(toolOnlyMessage.parts.map((part) => part.type), ["reasoning", "tool_call"]);
  assert.equal(toolOnlyMessage.parts[1].name, "lookup");
  assert.equal(toolOnlyMessage.parts[1].arguments.apiToken, "[REDACTED]");
  const textToolMessage = JSON.parse(llms[1].attributes["gen_ai.output.messages"])[0];
  assert.deepEqual(textToolMessage.parts.map((part) => part.type), ["reasoning", "text", "tool_call"]);
  assert.equal(textToolMessage.parts[2].arguments.value, "synthetic");
  const finalMessage = JSON.parse(llms[2].attributes["gen_ai.output.messages"])[0];
  assert.deepEqual(finalMessage.parts, [{ type: "text", content: "Synthetic completion." }]);

  const resourceMetrics = deriveMetrics(spans);
  const tokenMetric = resourceMetrics.scopeMetrics[0].metrics
    .find((metric) => metric.descriptor.name === "gen_ai.client.token.usage");
  assert.equal(tokenMetric.dataPoints.length, 6);
  assert.deepEqual(tokenMetric.dataPoints.map((point) => point.value.sum), [15, 2, 27, 3, 44, 5]);
});

test("real transcript response timestamps match every long model call one-to-one", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-real-time-"));
  const startMs = 1_784_500_000_000;
  const durations = [2_050, 5_340, 1_680, 3_860, 4_400, 4_770, 6_540, 7_070, 7_630];
  let cursor = startMs + 100;
  const llmCalls = durations.map((durationMs, index) => {
    const call = {
      callId: `real-call-${index + 1}`,
      startMs: cursor,
      endMs: cursor + durationMs,
      outcome: "completed"
    };
    cursor = call.endMs + 75;
    return call;
  });
  const turn = transcriptTurn({
    startMs,
    endMs: cursor + 100,
    aggregateUsage: undefined,
    llmCalls
  });
  const records = llmCalls.map((call, index) => {
    const isFinal = index === llmCalls.length - 1;
    const content = index % 3 === 0
      ? [{ type: "toolCall", id: `tool-${index}`, name: `lookup-${index}`, arguments: { value: "synthetic" } }]
      : index % 3 === 1
        ? [
            { type: "text", text: `Synthetic intermediate ${index}.` },
            { type: "toolCall", id: `tool-${index}`, name: `format-${index}`, arguments: { value: "synthetic" } }
          ]
        : [{ type: "text", text: isFinal ? "Synthetic final response." : `Synthetic response ${index}.` }];
    return assistantTranscriptRecord(call.endMs - 20, {
      content,
      usage: { input: index + 1, cacheRead: index + 10, output: index + 100 },
      stopReason: isFinal || index % 3 === 2 ? "stop" : "toolUse"
    }, call.startMs);
  });
  await writeTranscript(temp, turn.sessionId, records);

  const result = await readAndEnrichTranscript(temp, turn, resolveConfig({ captureContent: "preview" }));
  assert.equal(result.matched, llmCalls.length);
  assert.equal(result.finalText, "Synthetic final response.");
  assert.deepEqual(turn.llmCalls.map((call) => call.transcriptTimeMs), llmCalls.map((call) => call.endMs - 20));
  assert.deepEqual(turn.llmCalls.map((call) => call.usage.input), llmCalls.map((_, index) => index + 1));
  assert.deepEqual(turn.llmCalls.map((call) => call.usage.output), llmCalls.map((_, index) => index + 100));
  assert.equal(turn.llmCalls[0].output, "tool_call: lookup-0");
  assert.equal(turn.llmCalls[1].output, "Synthetic intermediate 1.");
  assert.equal(turn.llmCalls.at(-1).output, "Synthetic final response.");

  const llms = buildSpanBatch(turn, {}, resolveConfig({ captureContent: "preview" }))
    .filter((span) => span.name === "llm");
  assert.deepEqual(llms.map((span) => span.durationMs), durations);
  assert.deepEqual(
    llms.map((span) => span.attributes["gen_ai.usage.input_tokens"]),
    llmCalls.map((_, index) => (index + 1) + (index + 10))
  );
  assert.deepEqual(
    llms.map((span) => span.attributes["gen_ai.usage.output_tokens"]),
    llmCalls.map((_, index) => index + 100)
  );
});

test("transcript matching falls back to the inner timestamp when the outer timestamp is absent", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-time-fallback-"));
  const turn = transcriptTurn();
  const record = assistantTranscriptRecord(turn.llmCalls[0].endMs - 10, {
    content: [{ type: "text", text: "Synthetic fallback response." }],
    usage: { input: 7, cacheRead: 2, output: 1 },
    stopReason: "stop"
  });
  delete record.timestamp;
  await writeTranscript(temp, turn.sessionId, [record]);

  const result = await readAndEnrichTranscript(temp, turn, resolveConfig({ captureContent: "preview" }));
  assert.equal(result.matched, 1);
  assert.equal(turn.llmCalls[0].output, "Synthetic fallback response.");
  assert.deepEqual(turn.llmCalls[0].usage, { input: 7, cacheRead: 2, output: 1 });
});

test("captureContent=none keeps per-call usage and output kinds without transcript content", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-none-"));
  const turn = transcriptTurn();
  await writeTranscript(temp, turn.sessionId, [
    assistantTranscriptRecord(turn.llmCalls[0].endMs - 10, {
      content: [{ type: "toolCall", id: "private-id", name: "lookup", arguments: { secret: "private-value" } }],
      usage: { input: 3, cacheRead: 4, output: 1 },
      stopReason: "toolUse"
    })
  ]);
  const config = resolveConfig({ captureContent: "none" });
  const result = await readAndEnrichTranscript(temp, turn, config);
  assert.equal(result.matched, 1);
  assert.equal(turn.llmCalls[0].output, undefined);
  assert.equal(turn.llmCalls[0].outputMessage, undefined);
  assert.equal(turn.llmCalls[0].outputKind, "tool_call");
  assert.ok(turn.llmCalls[0].outputLength > 0);

  const llm = buildSpanBatch(turn, {}, config).find((span) => span.name === "llm");
  assert.equal(llm.attributes["gen_ai.output.messages"], undefined);
  assert.equal(llm.attributes.output_preview, undefined);
  assert.equal(llm.attributes.output_kind, "tool_call");
  assert.ok(llm.attributes.output_length > 0);
  assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 7);
});

test("captureContent=full redacts transcript reasoning and tool arguments", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-full-"));
  const turn = transcriptTurn();
  await writeTranscript(temp, turn.sessionId, [
    assistantTranscriptRecord(turn.llmCalls[0].endMs - 10, {
      content: [
        { type: "thinking", thinking: "Use Bearer secret-value-12345678 for the synthetic thought." },
        { type: "toolCall", id: "tool-private", name: "lookup", arguments: { password: "private-value", query: "synthetic" } }
      ],
      usage: { input: 3, cacheRead: 4, output: 1 },
      stopReason: "toolUse"
    })
  ]);

  const config = resolveConfig({ captureContent: "full", maxChars: 10_000 });
  const result = await readAndEnrichTranscript(temp, turn, config);
  assert.equal(result.matched, 1);
  const llm = buildSpanBatch(turn, {}, config).find((span) => span.name === "llm");
  const serialized = llm.attributes["gen_ai.output.messages"];
  assert.doesNotMatch(serialized, /secret-value-12345678|private-value/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(JSON.parse(serialized)[0].parts[1].arguments.password, "[REDACTED]");
});

test("malformed or unmatched transcript records fail open without shifting later calls", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-fail-open-"));
  const turn = transcriptTurn();
  await writeTranscript(temp, turn.sessionId, [
    "{this is deliberately malformed",
    assistantTranscriptRecord(turn.startMs - 60_000, {
      content: [{ type: "text", text: "Outside this turn." }],
      usage: { input: 999, output: 999 },
      stopReason: "stop"
    }),
    assistantTranscriptRecord(turn.llmCalls[1].endMs - 10, {
      content: [{ type: "text", text: "Only the second call is present." }],
      usage: { input: 8, cacheRead: 2, output: 1 },
      stopReason: "toolUse"
    })
  ]);
  const result = await readAndEnrichTranscript(temp, turn, resolveConfig({ captureContent: "preview" }));
  assert.equal(result.matched, 1);
  assert.equal(turn.llmCalls[0].usage, undefined);
  assert.equal(turn.llmCalls[1].output, "Only the second call is present.");
  assert.equal(turn.llmCalls[2].usage, undefined);

  const missing = await readAndEnrichTranscript(temp, { ...turn, sessionId: "missing-session" }, resolveConfig({}));
  assert.equal(missing.matched, 0);
});

test("ambiguous equal-nearest transcript records are not guessed", () => {
  const turn = transcriptTurn({ llmCalls: [{ startMs: 1_000, endMs: 2_000 }] });
  const matches = __transcriptTest.matchAssistantRecords(turn, [{ timeMs: 1_990 }, { timeMs: 1_990 }]);
  assert.deepEqual(matches, []);
});

test("transcript path rejects traversal and non-session path segments", async () => {
  const turn = transcriptTurn();
  assert.ok(sessionTranscriptPath("/synthetic-state", turn)?.endsWith("/agents/main/sessions/transcript-session.jsonl"));
  assert.equal(sessionTranscriptPath("/synthetic-state", { ...turn, agentId: "../main" }), undefined);
  assert.equal(sessionTranscriptPath("/synthetic-state", { ...turn, agentId: "..\\main" }), undefined);
  assert.equal(sessionTranscriptPath("/synthetic-state", { ...turn, sessionId: "../transcript-session" }), undefined);
  assert.equal(sessionTranscriptPath("/synthetic-state", { ...turn, sessionId: "..\\transcript-session" }), undefined);
  assert.equal(
    (await readAndEnrichTranscript("/synthetic-state", { ...turn, sessionId: "../transcript-session" }, resolveConfig({}))).matched,
    0
  );
});

test("transcript enrichment rejects parent symlinks, oversized files, and mismatched headers", async () => {
  const config = resolveConfig({ captureContent: "preview" });
  const turn = transcriptTurn();

  const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-symlink-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-outside-"));
  await writeTranscript(outsideRoot, turn.sessionId, []);
  await fs.symlink(path.join(outsideRoot, "agents"), path.join(symlinkRoot, "agents"), "dir");
  assert.equal((await readAndEnrichTranscript(symlinkRoot, turn, config)).matched, 0);

  const finalSymlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-final-symlink-"));
  const finalSessions = path.join(finalSymlinkRoot, "agents", "main", "sessions");
  await fs.mkdir(finalSessions, { recursive: true });
  await fs.symlink(
    path.join(outsideRoot, "agents", "main", "sessions", `${turn.sessionId}.jsonl`),
    path.join(finalSessions, `${turn.sessionId}.jsonl`)
  );
  assert.equal((await readAndEnrichTranscript(finalSymlinkRoot, turn, config)).matched, 0);

  const oversizedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-oversized-"));
  await writeTranscript(oversizedRoot, turn.sessionId, []);
  const oversizedPath = sessionTranscriptPath(oversizedRoot, turn);
  await fs.truncate(oversizedPath, __transcriptTest.MAX_TRANSCRIPT_BYTES + 1);
  const oversized = await readAndEnrichTranscript(oversizedRoot, turn, config);
  assert.equal(oversized.matched, 0);
  assert.equal(oversized.sessionCreateMs, undefined);

  const mismatchedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-transcript-header-"));
  const sessions = path.join(mismatchedRoot, "agents", "main", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, `${turn.sessionId}.jsonl`), JSON.stringify({
    type: "session",
    id: "different-session",
    timestamp: "2026-08-24T02:00:00.000Z"
  }));
  const mismatched = await readAndEnrichTranscript(mismatchedRoot, turn, config);
  assert.equal(mismatched.matched, 0);
  assert.equal(mismatched.sessionCreateMs, undefined);
  await fs.writeFile(path.join(sessions, `${turn.sessionId}.jsonl`), JSON.stringify({
    type: "session",
    timestamp: "2026-08-24T02:00:00.000Z"
  }));
  const missingId = await readAndEnrichTranscript(mismatchedRoot, turn, config);
  assert.equal(missingId.matched, 0);
  assert.equal(missingId.sessionCreateMs, undefined);
});

test("transcript finish reasons normalize tool, stop, and cancellation outcomes", () => {
  assert.equal(__transcriptTest.finishReason("toolUse"), "tool_call");
  assert.equal(__transcriptTest.finishReason("stop"), "stop");
  assert.equal(__transcriptTest.finishReason("aborted"), "cancelled");
});

test("runtime preserves each model call across a multi-tool agent loop", () => {
  let currentTime = 1_784_200_000_000;
  const config = resolveConfig({ captureContent: "preview" });
  const runtime = createLobsterAiRuntime({ config, logger, now: () => currentTime });
  const ctx = {
    runId: "split-loop-run",
    sessionId: "split-loop-session",
    sessionKey: "agent:main:split-loop",
    trigger: "user"
  };

  runtime.handlers.onBeforeAgentRun({ prompt: "Perform the synthetic task." }, ctx);
  currentTime += 50;
  runtime.handlers.onLlmInput({
    runId: ctx.runId,
    provider: "example",
    model: "model-test",
    prompt: "Perform the synthetic task."
  }, ctx);

  currentTime += 5;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId, callId: "model-call-1" }, ctx);
  currentTime += 100;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, callId: "model-call-1", durationMs: 100, outcome: "completed" }, ctx);
  currentTime += 10;
  runtime.handlers.onBeforeToolCall({ runId: ctx.runId, toolCallId: "tool-exec", toolName: "exec", params: {} }, ctx);
  currentTime += 20;
  runtime.handlers.onAfterToolCall({ runId: ctx.runId, toolCallId: "tool-exec", toolName: "exec", result: "ok" }, ctx);

  currentTime += 10;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId, callId: "model-call-2" }, ctx);
  currentTime += 120;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, callId: "model-call-2", durationMs: 120, outcome: "completed" }, ctx);
  currentTime += 5;
  runtime.handlers.onBeforeToolCall({ runId: ctx.runId, toolCallId: "tool-write", toolName: "write", params: {} }, ctx);
  runtime.handlers.onBeforeToolCall({ runId: ctx.runId, toolCallId: "tool-edit", toolName: "edit", params: {} }, ctx);
  currentTime += 30;
  runtime.handlers.onAfterToolCall({ runId: ctx.runId, toolCallId: "tool-write", toolName: "write", result: "ok" }, ctx);
  currentTime += 5;
  runtime.handlers.onAfterToolCall({ runId: ctx.runId, toolCallId: "tool-edit", toolName: "edit", result: "ok" }, ctx);

  currentTime += 10;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId, callId: "model-call-3" }, ctx);
  currentTime += 80;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, callId: "model-call-3", durationMs: 80, outcome: "completed" }, ctx);
  currentTime += 5;
  runtime.handlers.onLlmOutput({
    runId: ctx.runId,
    provider: "example",
    model: "model-test",
    assistantTexts: ["Synthetic task complete."],
    usage: { input: 30, cacheRead: 70, output: 9 },
    lastAssistant: { stopReason: "stop" }
  }, ctx);

  const turn = runtime.inspect().turns.get(ctx.runId);
  assert.deepEqual(turn.llmCalls.map((call) => call.callId), ["model-call-1", "model-call-2", "model-call-3"]);
  assert.ok(turn.llmCalls.every((call) => call.startMs < call.endMs));
  assert.equal(turn.llmCalls[0].output, undefined);
  assert.equal(turn.llmCalls[1].output, undefined);
  assert.equal(turn.llmCalls[2].output, "Synthetic task complete.");
  assert.equal(turn.llmCalls[0].usage, undefined);
  assert.equal(turn.llmCalls[1].usage, undefined);
  assert.equal(turn.llmCalls[2].usage, undefined);
  assert.deepEqual(turn.aggregateUsage, { input: 30, cacheRead: 70, output: 9 });

  const spans = buildSpanBatch({
    ...turn,
    endMs: currentTime + 10,
    finalStatus: "completed",
    success: true
  }, {}, config);
  const root = spans[0];
  const llmSpans = spans.filter((span) => span.name === "llm")
    .sort((left, right) => left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1]);
  assert.equal(llmSpans.length, 3);
  assert.equal(root.attributes["gen_ai.usage.input_tokens"], 100);
  assert.equal(root.attributes["gen_ai.usage.output_tokens"], 9);
  assert.equal(llmSpans[0].attributes["gen_ai.usage.input_tokens"], undefined);
  assert.equal(llmSpans[1].attributes["gen_ai.usage.input_tokens"], undefined);
  assert.equal(llmSpans[2].attributes["gen_ai.usage.input_tokens"], undefined);

  const rootChildren = spans.filter((span) => span.parentSpanContext?.spanId === root.spanContext().spanId)
    .sort((left, right) => left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1]);
  assert.deepEqual(rootChildren.map((span) => span.name), [
    "llm",
    "tool:exec",
    "llm",
    "tool:write",
    "tool:edit",
    "llm",
    "assistant"
  ]);
  assert.equal(
    rootChildren.find((span) => span.name === "tool:exec").attributes["triggered_by.llm_span_id"],
    llmSpans[0].spanContext().spanId
  );
  for (const name of ["tool:write", "tool:edit"]) {
    assert.equal(
      rootChildren.find((span) => span.name === name).attributes["triggered_by.llm_span_id"],
      llmSpans[1].spanContext().spanId
    );
  }

  const resourceMetrics = deriveMetrics(spans);
  const operationCount = resourceMetrics.scopeMetrics[0].metrics
    .find((metric) => metric.descriptor.name === "gen_ai.agent.operation.count");
  assert.equal(operationCount.dataPoints.length, 6);
  assert.equal(
    resourceMetrics.scopeMetrics[0].metrics
      .find((metric) => metric.descriptor.name === "gen_ai.client.token.usage"),
    undefined
  );
});

test("runtime missing-callId fallback never overwrites a completed model call", () => {
  let currentTime = 1_784_300_000_000;
  const config = resolveConfig({ captureContent: "none" });
  const runtime = createLobsterAiRuntime({ config, logger, now: () => currentTime });
  const ctx = {
    runId: "anonymous-loop-run",
    sessionId: "anonymous-loop-session",
    sessionKey: "agent:main:anonymous-loop",
    trigger: "user"
  };

  runtime.handlers.onBeforeAgentRun({ prompt: "Perform another synthetic task." }, ctx);
  currentTime += 10;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId }, ctx);
  currentTime += 100;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, durationMs: 100, outcome: "completed" }, ctx);
  currentTime += 10;
  runtime.handlers.onModelCallStarted({ runId: ctx.runId }, ctx);
  currentTime += 100;
  runtime.handlers.onModelCallEnded({ runId: ctx.runId, durationMs: 100, outcome: "completed" }, ctx);

  const calls = runtime.inspect().turns.get(ctx.runId).llmCalls;
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endMs < calls[1].startMs);
  assert.ok(calls.every((call) => call.startMs < call.endMs));
});

test("internal heartbeat terminal turns are dropped by default", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-heartbeat-"));
  let uploaded = 0;
  const config = resolveConfig({ profile: "otlp", stateDir: temp, retryIntervalMs: 600_000 });
  const runtime = createLobsterAiRuntime({
    config,
    logger,
    fetchImpl: async () => { uploaded += 1; return new Response(new Uint8Array(), { status: 200 }); }
  });
  await runtime.start(temp);
  const ctx = { runId: "heartbeat-run", sessionId: "heartbeat-session", trigger: "heartbeat" };
  runtime.handlers.onBeforeAgentRun({ prompt: "internal heartbeat" }, ctx);
  await runtime.handlers.handleAgentEnd({ runId: ctx.runId, success: true, messages: [] }, ctx);
  assert.equal(uploaded, 0);
  await runtime.stop();
});

test("agent hook runtime lazily starts from state discovered by the gateway runtime", async () => {
  __runtimeTest.resetSharedStateDir();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-shared-state-"));
  const config = resolveConfig({
    enabled: true,
    profile: "otlp",
    endpoint: "http://receiver.test",
    captureContent: "none",
    retryIntervalMs: 600_000
  });
  const gatewayRuntime = createLobsterAiRuntime({ config, logger, fetchImpl: async () => new Response(new Uint8Array(), { status: 200 }) });
  await gatewayRuntime.start(temp);

  const signals = [];
  const hookRuntime = createLobsterAiRuntime({
    config,
    logger,
    fetchImpl: async (url) => {
      signals.push(String(url).includes("metrics") ? "metrics" : "traces");
      return new Response(new Uint8Array(), { status: 200 });
    }
  });
  const ctx = { runId: "shared-run", sessionId: "shared-session", trigger: "user" };
  hookRuntime.handlers.onBeforeAgentRun({ prompt: "Synthetic prompt" }, ctx);
  await hookRuntime.handlers.handleAgentEnd({ runId: ctx.runId, success: true }, ctx);
  assert.deepEqual(signals, ["traces", "metrics"]);
  assert.match(hookRuntime.inspect().stateRoot, /lobsterai-otel-plugin$/);
  await hookRuntime.stop();
  await gatewayRuntime.stop();
});
