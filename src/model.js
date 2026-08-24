import path from "node:path";
import { captureText, safeJson } from "./privacy.js";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return contentText(value.content);
  if (typeof value.message === "string") return value.message;
  return "";
}

export function createTurn(event, ctx, now = Date.now()) {
  const prompt = typeof event?.prompt === "string" ? event.prompt : "";
  return {
    runId: event?.runId ?? ctx?.runId,
    sessionId: event?.sessionId ?? ctx?.sessionId,
    sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    agentId: ctx?.agentId,
    channelId: event?.channelId ?? ctx?.channelId ?? ctx?.messageProvider,
    trigger: ctx?.trigger,
    sessionCreateMs: undefined,
    startMs: now,
    endMs: undefined,
    prompt,
    historyMessages: Array.isArray(event?.messages) ? event.messages : [],
    systemPrompt: typeof event?.systemPrompt === "string" ? event.systemPrompt : undefined,
    llmCalls: [],
    aggregateUsage: undefined,
    toolCalls: [],
    assistantOutputs: [],
    subagent: undefined,
    finalStatus: "unset",
    success: undefined,
    error: undefined
  };
}

export function isInternalTurn(turn) {
  const trigger = String(turn.trigger ?? "").toLowerCase();
  return ["heartbeat", "title", "summary", "compaction", "review", "memory"].some((item) => trigger.includes(item));
}

export function terminalStatus(event) {
  if (event?.success !== false) return { finalStatus: "completed", status: "ok" };
  const error = String(event?.error ?? "");
  // OpenClaw emits success=false with no promptError for an aborted run.
  if (!error || /abort|cancel|interrupt|killed|user_stop/i.test(error)) {
    return { finalStatus: "cancelled", status: "error", errorType: "cancelled" };
  }
  return { finalStatus: "completed", status: "error", errorType: classifyError(error) };
}

export function classifyError(value) {
  const text = String(value ?? "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("rate limit") || text.includes("429")) return "rate_limit";
  if (text.includes("auth") || text.includes("401") || text.includes("403")) return "authentication";
  if (text.includes("abort") || text.includes("cancel")) return "cancelled";
  return "runtime_error";
}

export function normalizeUsage(usage = {}) {
  const uncachedInput = finite(usage.input) ?? 0;
  const cacheRead = finite(usage.cacheRead) ?? 0;
  return {
    input: Math.max(0, uncachedInput + cacheRead),
    output: Math.max(0, finite(usage.output) ?? 0),
    cacheRead: Math.max(0, cacheRead),
    reasoning: Math.max(0, finite(usage.reasoningTokens) ?? finite(usage.reasoning) ?? 0)
  };
}

export function outputFromLlmEvent(event) {
  const assistantTexts = Array.isArray(event?.assistantTexts)
    ? event.assistantTexts.filter((item) => typeof item === "string")
    : [];
  return assistantTexts.join("\n") || contentText(event?.lastAssistant);
}

export function finishReasons(event) {
  const assistant = event?.lastAssistant;
  const reason = assistant && typeof assistant === "object"
    ? assistant.stopReason ?? assistant.stop_reason ?? assistant.finishReason ?? assistant.finish_reason
    : undefined;
  return typeof reason === "string" && reason ? [reason] : [];
}

function stringFromParams(params, names) {
  for (const name of names) {
    if (typeof params?.[name] === "string" && params[name].trim()) return params[name].trim();
  }
  return undefined;
}

export function toolCommand(params) {
  return stringFromParams(params, ["cmd", "command"]);
}

export function skillEvidence(toolName, params = {}) {
  if (String(toolName).toLowerCase() === "skill") {
    const name = stringFromParams(params, ["name", "skill", "skillName"]);
    if (name) return { name, sourceType: "product_event" };
  }
  for (const value of Object.values(params)) {
    if (typeof value !== "string") continue;
    const normalized = value.replaceAll("\\", "/");
    if (!/(^|\/)SKILL\.md$/i.test(normalized)) continue;
    const skillDir = path.dirname(normalized);
    const name = path.basename(skillDir);
    if (name && name !== "." && name !== "/") {
      return { name, path: value, sourceType: "skill_md" };
    }
  }
  return undefined;
}

export function messageAttributes(role, text, config) {
  const captured = captureText(text, config);
  if (!captured.value) return undefined;
  return JSON.stringify([{ role, parts: [{ type: "text", content: captured.value }] }]);
}

export function structuredMessageAttributes(message, config) {
  if (!message || config.captureContent === "none") return undefined;
  return safeJson([message], config);
}

export function capturedAttributes(prefix, value, config) {
  const captured = captureText(value, config);
  return {
    ...(captured.value ? { [`${prefix}_preview`]: captured.value } : {}),
    [`${prefix}_length`]: captured.length
  };
}

export function toolPayloadAttributes(tool, config) {
  return {
    ...(config.captureContent !== "none" ? {
      "gen_ai.tool.call.arguments": safeJson(tool.params, config),
      "gen_ai.tool.call.result": safeJson(tool.result, config),
      tool_command: toolCommand(tool.params)
    } : {})
  };
}
