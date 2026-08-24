import { createHash } from "node:crypto";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { captureText } from "./privacy.js";
import {
  capturedAttributes,
  classifyError,
  contentText,
  messageAttributes,
  normalizeUsage,
  structuredMessageAttributes,
  toolPayloadAttributes
} from "./model.js";

const SCOPE = { name: "lobsterai-otel-plugin", version: "0.1.0" };

function hashHex(value, length) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function hrTime(ms) {
  const safe = Math.max(0, Math.floor(ms));
  return [Math.floor(safe / 1000), (safe % 1000) * 1_000_000];
}

function isoTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const value = new Date(ms);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}

function attributes(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null) return false;
    if (Array.isArray(item)) return item.length > 0;
    return typeof item === "string" ? item.length > 0 : true;
  }));
}

function clampWindow(start, end, parentStart, parentEnd) {
  const safeStart = Math.max(parentStart, Math.min(start ?? parentStart, parentEnd - 1));
  const safeEnd = Math.max(safeStart + 1, Math.min(end ?? parentEnd, parentEnd));
  return [safeStart, safeEnd];
}

function readableSpan({ traceId, spanId, parentSpanId, name, startMs, endMs, attrs, status, resource }) {
  const context = { traceId, spanId, traceFlags: 1, isRemote: false };
  const parentSpanContext = parentSpanId ? { traceId, spanId: parentSpanId, traceFlags: 1, isRemote: false } : undefined;
  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => context,
    parentSpanContext,
    startTime: hrTime(startMs),
    endTime: hrTime(endMs),
    duration: hrTime(Math.max(1, endMs - startMs)),
    status: status === "error"
      ? { code: SpanStatusCode.ERROR, message: String(attrs.reason ?? attrs["error.type"] ?? "") }
      : { code: SpanStatusCode.OK },
    attributes: attributes(attrs),
    links: [],
    events: [],
    resource,
    instrumentationScope: SCOPE,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    durationMs: Math.max(1, endMs - startMs)
  };
}

function common(turn) {
  return {
    "gen_ai.conversation.id": turn.sessionId ?? turn.sessionKey,
    session_id: turn.sessionId ?? turn.sessionKey
  };
}

function safeReason(value, config) {
  return captureText(value, config).value;
}

function latestAssistantText(turn, terminalEvent) {
  const tracked = turn.assistantOutputs.at(-1)?.text;
  if (tracked) return tracked;
  const messages = Array.isArray(terminalEvent?.messages) ? terminalEvent.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      const text = contentText(messages[index]);
      if (text) return text;
    }
  }
  return "";
}

export function buildSpanBatch(turn, terminalEvent, config) {
  const rootStart = turn.startMs;
  const rootEnd = Math.max(rootStart + 1, turn.endMs ?? Date.now());
  const traceId = hashHex(`trace:${turn.runId}`, 32);
  const rootSpanId = hashHex(`root:${turn.runId}`, 16);
  const resource = resourceFromAttributes(config.resourceAttributes);
  const shared = common(turn);
  const output = latestAssistantText(turn, terminalEvent);
  const rootStatus = turn.success === false ? "error" : "ok";
  const llmUsage = turn.llmCalls.map((call) => normalizeUsage(call.usage));
  const summedLlmUsage = llmUsage.reduce((sum, usage) => ({
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    reasoning: sum.reasoning + usage.reasoning
  }), { input: 0, output: 0, cacheRead: 0, reasoning: 0 });
  const totalUsage = turn.aggregateUsage
    ? normalizeUsage(turn.aggregateUsage)
    : summedLlmUsage;
  const lastLlm = turn.llmCalls.at(-1);
  const inputMessages = messageAttributes("user", turn.prompt, config);
  const outputMessages = messageAttributes("assistant", output, config);
  const rootAttrs = {
    ...shared,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "LobsterAI",
    "gen_ai.provider.name": lastLlm?.provider,
    "gen_ai.request.model": lastLlm?.model,
    "gen_ai.response.model": lastLlm?.responseModel ?? lastLlm?.model,
    "gen_ai.response.finish_reasons": lastLlm?.finishReasons,
    "gen_ai.input.messages": inputMessages,
    "gen_ai.output.messages": outputMessages,
    "gen_ai.output.type": output ? "text" : undefined,
    "gen_ai.usage.input_tokens": totalUsage.input || undefined,
    "gen_ai.usage.output_tokens": totalUsage.output || undefined,
    "gen_ai.usage.cache_read.input_tokens": totalUsage.cacheRead || undefined,
    "gen_ai.usage.reasoning.output_tokens": totalUsage.reasoning || undefined,
    // Agent Monitoring's current Session aggregation still reads these
    // compatibility aliases. Keep the canonical GenAI attributes above as
    // the semantic source of truth and expose aliases only on the root span.
    usage_input_tokens: totalUsage.input || undefined,
    usage_output_tokens: totalUsage.output || undefined,
    session_create_at: isoTime(turn.sessionCreateMs),
    session_updated_at: isoTime(rootEnd),
    session_channel: turn.channelId,
    tool_count: turn.toolCalls.length,
    final_status: turn.finalStatus,
    status: rootStatus,
    "error.type": rootStatus === "error" ? classifyError(turn.error) : undefined,
    reason: rootStatus === "error" ? safeReason(turn.error, config) : undefined,
    ...capturedAttributes("input", turn.prompt, config),
    ...capturedAttributes("output", output, config),
    ...(turn.subagent ? {
      "gen_ai.subagent.parent.run_id": turn.subagent.parentRunId,
      "gen_ai.subagent.parent.session_key": turn.subagent.parentSessionKey
    } : {})
  };
  const spans = [readableSpan({
    traceId,
    spanId: rootSpanId,
    name: "invoke_agent",
    startMs: rootStart,
    endMs: rootEnd,
    attrs: rootAttrs,
    status: rootStatus,
    resource
  })];

  const llmSpanByIndex = [];
  turn.llmCalls.forEach((call, index) => {
    const [startMs, endMs] = clampWindow(call.startMs, call.endMs, rootStart, rootEnd);
    const spanId = hashHex(`llm:${turn.runId}:${call.callId ?? index}`, 16);
    llmSpanByIndex.push({ startMs, spanId });
    const usage = normalizeUsage(call.usage);
    const input = call.prompt ?? turn.prompt;
    const outputText = call.output ?? "";
    const outputCaptured = capturedAttributes("output", outputText, config);
    if (typeof call.outputLength === "number" && Number.isFinite(call.outputLength)) {
      outputCaptured.output_length = Math.max(0, call.outputLength);
    }
    const status = call.outcome === "error" || call.error ? "error" : "ok";
    spans.push(readableSpan({
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: "llm",
      startMs,
      endMs,
      status,
      resource,
      attrs: {
        ...shared,
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": call.provider,
        "gen_ai.request.model": call.model,
        "gen_ai.response.id": call.responseId,
        "gen_ai.response.model": call.responseModel ?? call.model,
        "gen_ai.response.finish_reasons": call.finishReasons,
        "gen_ai.input.messages": messageAttributes("user", input, config),
        "gen_ai.output.messages": structuredMessageAttributes(call.outputMessage, config)
          ?? messageAttributes("assistant", outputText, config),
        "gen_ai.output.type": call.outputKind ?? (outputText ? "text" : undefined),
        output_kind: call.outputKind,
        "gen_ai.usage.input_tokens": usage.input || undefined,
        "gen_ai.usage.output_tokens": usage.output || undefined,
        "gen_ai.usage.cache_read.input_tokens": usage.cacheRead || undefined,
        "gen_ai.usage.reasoning.output_tokens": usage.reasoning || undefined,
        ttft: call.ttftMs,
        status,
        "error.type": status === "error" ? call.errorType ?? classifyError(call.error) : undefined,
        ...capturedAttributes("input", input, config),
        ...outputCaptured
      }
    }));
  });

  turn.toolCalls.forEach((tool, index) => {
    const [startMs, endMs] = clampWindow(tool.startMs, tool.endMs, rootStart, rootEnd);
    const spanId = hashHex(`tool:${turn.runId}:${tool.callId ?? index}`, 16);
    const status = tool.error ? "error" : "ok";
    const triggeringLlm = [...llmSpanByIndex].reverse().find((item) => item.startMs <= startMs);
    const toolAttrs = {
      ...shared,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": tool.name,
      "gen_ai.tool.call.id": tool.callId,
      tool_result_status: status === "error" ? "error" : "completed",
      status,
      "error.type": status === "error" ? classifyError(tool.error) : undefined,
      reason: status === "error" ? safeReason(tool.error, config) : undefined,
      "triggered_by.llm_span_id": triggeringLlm?.spanId,
      ...toolPayloadAttributes(tool, config)
    };
    spans.push(readableSpan({ traceId, spanId, parentSpanId: rootSpanId, name: `tool:${tool.name}`, startMs, endMs, attrs: toolAttrs, status, resource }));

    if (tool.skill) {
      const skillSpanId = hashHex(`skill:${turn.runId}:${tool.callId ?? index}:${tool.skill.name}`, 16);
      spans.push(readableSpan({
        traceId,
        spanId: skillSpanId,
        parentSpanId: spanId,
        name: `skill:${tool.skill.name}`,
        startMs,
        endMs,
        status,
        resource,
        attrs: {
          ...shared,
          "gen_ai.operation.name": "skill",
          "gen_ai.skill.name": tool.skill.name,
          "gen_ai.skill.path": config.captureContent === "none" ? undefined : tool.skill.path,
          "gen_ai.skill.source.type": tool.skill.sourceType,
          "gen_ai.skill.result.status": status === "error" ? "error" : "completed",
          "skill.name": tool.skill.name,
          skill_path: config.captureContent === "none" ? undefined : tool.skill.path,
          skill_call_id: tool.callId,
          status
        }
      }));
    }
  });

  if (output) {
    const endMs = rootEnd;
    const startMs = Math.max(rootStart, endMs - 1);
    spans.push(readableSpan({
      traceId,
      spanId: hashHex(`assistant:${turn.runId}`, 16),
      parentSpanId: rootSpanId,
      name: "assistant",
      startMs,
      endMs,
      status: rootStatus,
      resource,
      attrs: {
        ...shared,
        "gen_ai.output.type": "text",
        "gen_ai.provider.name": lastLlm?.provider,
        "gen_ai.request.model": lastLlm?.model,
        "gen_ai.response.model": lastLlm?.responseModel ?? lastLlm?.model,
        output_kind: "text",
        status: rootStatus,
        ...capturedAttributes("output", output, config)
      }
    }));
  }

  return spans;
}

export const __spanTest = { hashHex, hrTime };
