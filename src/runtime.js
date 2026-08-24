import { buildSpanBatch } from "./spans.js";
import { deriveMetrics } from "./metrics.js";
import {
  contentText,
  createTurn,
  finishReasons,
  isInternalTurn,
  outputFromLlmEvent,
  skillEvidence,
  terminalStatus
} from "./model.js";
import { serializeSignals, uploadSignal } from "./otlp.js";
import { redactText } from "./privacy.js";
import { createStateStore } from "./state.js";
import { readAndEnrichTranscript } from "./transcript.js";

let sharedOpenClawStateDir;

function hookTime(event, fallback = Date.now()) {
  return typeof event?.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : fallback;
}

function sessionAliases(event, ctx) {
  return [...new Set([
    event?.sessionId,
    ctx?.sessionId,
    event?.sessionKey,
    ctx?.sessionKey
  ].filter((value) => typeof value === "string" && value.length > 0))];
}

async function sessionCreateMsFromTranscript(stateDir, turn) {
  const result = await readAndEnrichTranscript(stateDir, turn, { captureContent: "none", maxChars: 2000 });
  return result.sessionCreateMs;
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      const text = contentText(messages[index]);
      if (text) return text;
    }
  }
  return "";
}

function eventCallId(event) {
  return typeof event?.callId === "string" && event.callId.trim() ? event.callId : undefined;
}

function createLlmCall(turn, now, values = {}) {
  const call = { index: turn.llmCalls.length, startMs: now, ...values };
  turn.llmCalls.push(call);
  return call;
}

function callForModelStart(turn, event, now) {
  const callId = eventCallId(event);
  if (callId) {
    const exact = turn.llmCalls.find((item) => item.callId === callId);
    if (exact) return exact;

    // llm_input is run-level and can provision the first model call before a
    // model_call_started event supplies its stable ID. Only claim that explicit
    // pending record; never reuse an ended call merely because it has no output.
    const pending = [...turn.llmCalls].reverse().find((item) => item.provisional && !item.callId && !item.endMs);
    if (pending) return pending;
    return createLlmCall(turn, now);
  }

  // Older runtimes may omit callId. In that case retain a narrow fail-open
  // fallback to the latest open call before creating a new anonymous call.
  return [...turn.llmCalls].reverse().find((item) => !item.endMs)
    ?? createLlmCall(turn, now);
}

function callForModelEnd(turn, event, now) {
  const callId = eventCallId(event);
  if (callId) {
    // End events with IDs only correlate by exact ID. If the start event was
    // missed, preserve the call as a distinct inferred record.
    return turn.llmCalls.find((item) => item.callId === callId)
      ?? createLlmCall(turn, now, { callId, inferredStart: true });
  }

  // Without an ID, use only an open call. Creating an inferred record is safer
  // than rewriting a completed call boundary.
  return [...turn.llmCalls].reverse().find((item) => !item.endMs)
    ?? createLlmCall(turn, now, { inferredStart: true });
}

function callForRunOutput(turn, now) {
  // llm_output is emitted once for the whole run. It belongs to the final model
  // call for output display, but must never be used to merge call boundaries.
  return turn.llmCalls.at(-1) ?? createLlmCall(turn, now, { provisional: true });
}

function toolForEvent(turn, event, create = false, now = Date.now()) {
  let tool = event?.toolCallId ? turn.toolCalls.find((item) => item.callId === event.toolCallId) : undefined;
  if (!tool && create) {
    tool = {
      callId: event?.toolCallId,
      name: event?.toolName ?? "unknown",
      params: event?.params ?? {},
      startMs: now,
      inferredStart: true
    };
    turn.toolCalls.push(tool);
  }
  return tool;
}

function exportError(error, stage) {
  if (error && typeof error === "object") error.exportStage ??= stage;
  return error;
}

function safeErrorSummary(error, debug = false) {
  const stage = error?.exportStage ?? "unknown";
  const kind = error?.code ?? error?.name ?? "error";
  if (!debug) return `${stage}:${kind}`;
  const message = redactText(error?.message ?? "")
    .replace(/(["']).{80,}?\1/g, "$1[VALUE]$1")
    .slice(0, 200);
  return message ? `${stage}:${kind}: ${message}` : `${stage}:${kind}`;
}

export function createLobsterAiRuntime({ config, logger, fetchImpl = fetch, now = () => Date.now() }) {
  const turns = new Map();
  const pendingBySession = new Map();
  const childParents = new Map();
  const sessionMetadata = new Map();
  const background = new Set();
  const state = createStateStore({
    configuredStateDir: config.stateDir,
    claimTtlMs: config.claimTtlMs,
    retentionDays: config.retentionDays,
    logger
  });
  let retryTimer;
  let started = false;
  let startPromise;
  let runtimeStateDir;

  function debug(message) {
    if (config.debug) logger?.info?.(`[lobsterai-otel] ${message}`);
  }

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise));
  }

  function runId(event, ctx) {
    return event?.runId ?? ctx?.runId;
  }

  function sessionKey(event, ctx) {
    return event?.sessionKey ?? ctx?.sessionKey ?? event?.sessionId ?? ctx?.sessionId;
  }

  function sessionCreateMs(event, ctx) {
    for (const alias of sessionAliases(event, ctx)) {
      const metadata = sessionMetadata.get(alias);
      if (metadata) return metadata.createdAt;
    }
    return undefined;
  }

  function applySessionMetadata(turn, event, ctx) {
    turn.sessionId ??= event?.sessionId ?? ctx?.sessionId;
    turn.sessionKey ??= event?.sessionKey ?? ctx?.sessionKey;
    turn.sessionCreateMs ??= sessionCreateMs(event, ctx);
    return turn;
  }

  function ensureTurn(event = {}, ctx = {}, eventNow = now()) {
    const id = runId(event, ctx);
    if (id && turns.has(id)) return applySessionMetadata(turns.get(id), event, ctx);
    const session = sessionKey(event, ctx);
    if (id && session && pendingBySession.has(session)) {
      const pending = pendingBySession.get(session);
      pendingBySession.delete(session);
      pending.runId = id;
      turns.set(id, pending);
      return applySessionMetadata(pending, event, ctx);
    }
    const turn = applySessionMetadata(createTurn(event, ctx, eventNow), event, ctx);
    if (id) {
      turn.runId = id;
      const parent = childParents.get(id);
      if (parent) turn.subagent = parent;
      turns.set(id, turn);
    } else if (session) {
      pendingBySession.set(session, turn);
    }
    return turn;
  }

  function onSessionStart(event, ctx) {
    const aliases = sessionAliases(event, ctx);
    if (aliases.length === 0) return;
    const observedAt = hookTime(event, now());
    const existing = aliases.map((alias) => sessionMetadata.get(alias)).find(Boolean);
    const metadata = {
      createdAt: Math.min(existing?.createdAt ?? observedAt, observedAt),
      aliases: new Set([...(existing?.aliases ?? []), ...aliases])
    };
    for (const alias of metadata.aliases) sessionMetadata.set(alias, metadata);
  }

  function onSessionEnd(event, ctx) {
    const aliases = sessionAliases(event, ctx);
    for (const alias of aliases) {
      const metadata = sessionMetadata.get(alias);
      for (const linkedAlias of metadata?.aliases ?? [alias]) sessionMetadata.delete(linkedAlias);
      pendingBySession.delete(alias);
    }
    const id = runId(event, ctx);
    if (id) turns.delete(id);
  }

  function onBeforeAgentRun(event, ctx) {
    const turn = ensureTurn(event, ctx, now());
    turn.prompt = event?.prompt ?? turn.prompt;
    turn.historyMessages = Array.isArray(event?.messages) ? event.messages : turn.historyMessages;
    turn.systemPrompt = event?.systemPrompt ?? turn.systemPrompt;
    turn.channelId = event?.channelId ?? ctx?.channelId ?? turn.channelId;
    turn.trigger = ctx?.trigger ?? turn.trigger;
  }

  function onLlmInput(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    if (!turn.prompt && typeof event?.prompt === "string") turn.prompt = event.prompt;
    const pending = [...turn.llmCalls].reverse().find((item) => item.provisional && !item.callId && !item.endMs);
    const call = pending ?? createLlmCall(turn, time, { provisional: true });
    call.startMs = Math.min(call.startMs, time);
    call.provider = event?.provider ?? call.provider;
    call.model = event?.model ?? call.model;
    call.prompt = event?.prompt ?? call.prompt;
    call.historyMessages = event?.historyMessages ?? call.historyMessages;
    call.systemPrompt = event?.systemPrompt ?? call.systemPrompt;
  }

  function onModelCallStarted(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    const call = callForModelStart(turn, event, time);
    call.callId = eventCallId(event) ?? call.callId;
    delete call.provisional;
    delete call.inferredStart;
    call.startMs = time;
    call.provider = event?.provider ?? call.provider;
    call.model = event?.model ?? call.model;
  }

  function onModelCallEnded(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    const call = callForModelEnd(turn, event, time);
    call.callId = eventCallId(event) ?? call.callId;
    delete call.provisional;
    call.provider = event?.provider ?? call.provider;
    call.model = event?.model ?? call.model;
    call.endMs = time;
    if (typeof event?.durationMs === "number" && event.durationMs > 0 && call.inferredStart) {
      call.startMs = time - event.durationMs;
    }
    delete call.inferredStart;
    call.outcome = event?.outcome;
    call.errorType = event?.errorCategory ?? event?.failureKind;
    call.ttftMs = event?.timeToFirstByteMs;
  }

  function onLlmOutput(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    const call = callForRunOutput(turn, time);
    call.provider = event?.provider ?? call.provider;
    call.model = event?.model ?? call.model;
    call.responseModel = typeof event?.resolvedRef === "string" ? event.resolvedRef.split("/").at(-1) : call.model;
    call.output = outputFromLlmEvent(event);
    // Product hooks expose usage only on this run-level terminal event. Keep it
    // on the turn root: assigning it to the final call would misrepresent the
    // aggregate as that single model request's token usage.
    turn.aggregateUsage = event?.usage;
    call.finishReasons = finishReasons(event);
    call.endMs ??= time;
    if (call.output) turn.assistantOutputs.push({ text: call.output, timeMs: time });
  }

  function onBeforeToolCall(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    let tool = toolForEvent(turn, event, false, time);
    if (!tool) {
      tool = {
        callId: event?.toolCallId,
        name: event?.toolName ?? "unknown",
        params: event?.params ?? {},
        startMs: time,
        skill: skillEvidence(event?.toolName, event?.params)
      };
      turn.toolCalls.push(tool);
    }
  }

  function onAfterToolCall(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    const tool = toolForEvent(turn, event, true, time);
    tool.name = event?.toolName ?? tool.name;
    tool.params = event?.params ?? tool.params;
    tool.result = event?.result;
    tool.error = event?.error;
    tool.endMs = time;
    if (typeof event?.durationMs === "number" && event.durationMs > 0 && tool.inferredStart) {
      tool.startMs = time - event.durationMs;
    }
    delete tool.inferredStart;
    tool.skill ??= skillEvidence(tool.name, tool.params);
  }

  function onSubagentSpawned(event, ctx) {
    if (!event?.runId) return;
    childParents.set(event.runId, {
      parentRunId: ctx?.runId,
      parentSessionKey: ctx?.sessionKey,
      childSessionKey: event.childSessionKey
    });
  }

  async function upload(signal, body) {
    const result = await uploadSignal({
      signal,
      url: signal === "traces" ? config.tracesUrl : config.metricsUrl,
      body,
      config,
      fetchImpl
    });
    debug(`${signal} export succeeded (${result.bytes} bytes)`);
    return result;
  }

  async function exportTerminal(turn, event) {
    try {
      await start();
    } catch (error) {
      throw exportError(error, "runtime_start");
    }
    // LobsterAI/OpenClaw can dispatch agent_end immediately before llm_output.
    // The hook itself is already backgrounded, so a short grace period does not
    // block the host and lets the final output/usage join the terminal batch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const transcript = await readAndEnrichTranscript(runtimeStateDir, turn, config);
    debug(`transcript enrichment matched ${transcript.matched}/${turn.llmCalls.length} LLM calls`);
    turn.sessionCreateMs ??= transcript.sessionCreateMs;
    if (transcript.finalText && turn.assistantOutputs.length === 0) {
      turn.assistantOutputs.push({ text: transcript.finalText, timeMs: turn.endMs, source: "transcript" });
    }
    let spans;
    let metrics;
    let payloads;
    try {
      spans = buildSpanBatch(turn, event, config);
    } catch (error) {
      throw exportError(error, "build_spans");
    }
    try {
      metrics = deriveMetrics(spans);
    } catch (error) {
      throw exportError(error, "derive_metrics");
    }
    if (!metrics) return;
    try {
      payloads = serializeSignals(spans, metrics);
    } catch (error) {
      throw exportError(error, "serialize_otlp");
    }
    try {
      await state.process({
        sessionId: turn.sessionId ?? turn.sessionKey,
        runId: turn.runId,
        traces: payloads.traces,
        metrics: payloads.metrics
      }, upload);
    } catch (error) {
      throw exportError(error, "persist_or_upload");
    }
  }

  async function handleAgentEnd(event, ctx) {
    const time = now();
    const turn = ensureTurn(event, ctx, time);
    const id = runId(event, ctx) ?? turn.runId;
    if (!id) return;
    turn.runId = id;
    turn.endMs = time;
    if (typeof event?.durationMs === "number" && event.durationMs > 0 && turn.startMs >= time) {
      turn.startMs = time - event.durationMs;
    }
    turn.success = event?.success !== false;
    turn.error = event?.error;
    const terminal = terminalStatus(event);
    turn.finalStatus = terminal.finalStatus;
    if (!turn.prompt && Array.isArray(event?.messages)) turn.prompt = lastUserText(event.messages);
    const hasEvidence = Boolean(turn.prompt.trim() || turn.llmCalls.length || turn.toolCalls.length || turn.assistantOutputs.length);
    if (!hasEvidence || turn.finalStatus === "unset") {
      turns.delete(id);
      return;
    }
    if (config.internalRequestPolicy === "drop" && isInternalTurn(turn)) {
      debug("internal terminal turn dropped");
      turns.delete(id);
      return;
    }
    try {
      await exportTerminal(turn, event);
    } catch (error) {
      logger?.warn?.(`[lobsterai-otel] terminal export deferred (${safeErrorSummary(error, config.debug)})`);
    } finally {
      turns.delete(id);
    }
  }

  function registerHooks(api) {
    api.on("session_start", onSessionStart, { priority: -100, timeoutMs: 1000 });
    api.on("before_agent_run", onBeforeAgentRun, { priority: -100, timeoutMs: 1000 });
    api.on("llm_input", onLlmInput, { priority: -100, timeoutMs: 1000 });
    api.on("model_call_started", onModelCallStarted, { priority: -100, timeoutMs: 1000 });
    api.on("model_call_ended", onModelCallEnded, { priority: -100, timeoutMs: 1000 });
    api.on("llm_output", onLlmOutput, { priority: -100, timeoutMs: 1000 });
    api.on("before_tool_call", onBeforeToolCall, { priority: -100, timeoutMs: 1000 });
    api.on("after_tool_call", onAfterToolCall, { priority: -100, timeoutMs: 1000 });
    api.on("subagent_spawned", onSubagentSpawned, { priority: -100, timeoutMs: 1000 });
    api.on("agent_end", (event, ctx) => {
      track(handleAgentEnd(event, ctx));
    }, { priority: 100, timeoutMs: 1000 });
    api.on("session_end", onSessionEnd, { priority: 100, timeoutMs: 1000 });
  }

  async function start(openClawStateDir) {
    if (openClawStateDir) sharedOpenClawStateDir = openClawStateDir;
    if (started) return;
    if (startPromise) return startPromise;
    const resolvedStateDir = openClawStateDir ?? sharedOpenClawStateDir ?? process.env.OPENCLAW_STATE_DIR;
    if (!config.stateDir && !resolvedStateDir) {
      throw new Error("OpenClaw state directory is unavailable in this plugin context");
    }
    startPromise = (async () => {
      runtimeStateDir = resolvedStateDir;
      await state.start(resolvedStateDir);
      started = true;
      track(state.recover(upload));
      retryTimer = setInterval(() => track(state.recover(upload)), config.retryIntervalMs);
      retryTimer.unref?.();
      logger?.info?.("[lobsterai-otel] lifecycle hooks enabled; terminal OTLP trace and metric export ready");
    })();
    try {
      await startPromise;
    } finally {
      startPromise = undefined;
    }
  }

  async function stop() {
    started = false;
    if (retryTimer) clearInterval(retryTimer);
    await Promise.race([
      Promise.allSettled([...background]),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }

  return {
    registerHooks,
    start,
    stop,
    handlers: {
      onSessionStart,
      onBeforeAgentRun,
      onLlmInput,
      onModelCallStarted,
      onModelCallEnded,
      onLlmOutput,
      onBeforeToolCall,
      onAfterToolCall,
      onSubagentSpawned,
      onSessionEnd,
      handleAgentEnd
    },
    inspect: () => ({ turns, pendingBySession, childParents, sessionMetadata, stateRoot: state.root })
  };
}

export const __runtimeTest = {
  sessionCreateMsFromTranscript,
  safeErrorSummary,
  resetSharedStateDir() { sharedOpenClawStateDir = undefined; }
};
