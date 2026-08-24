import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { captureText, sanitizeValue } from "./privacy.js";

// Transcript records are written by the same process immediately before the
// corresponding model_call_ended hook. The outer tolerance only accommodates
// small clock/flush skew; call matching remains constrained to the individual
// hook window and the nearest model-call end timestamp.
const TURN_WINDOW_TOLERANCE_MS = 2_000;
const CALL_CLOCK_TOLERANCE_MS = 250;
const CALL_END_TOLERANCE_MS = 500;
const MAX_RETAINED_RECORD_FACTOR = 3;
const MIN_RETAINED_RECORDS = 16;
// A transcript is optional enrichment, not an authority that may consume
// unbounded hook-process I/O. Long-running sessions above this conservative
// ceiling remain exportable with hook-only LLM fields.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function safePathSegment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.includes("\0")) {
    return undefined;
  }
  if (value.includes("/") || value.includes("\\") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return undefined;
  }
  return path.basename(value) === value && path.win32.basename(value) === value ? value : undefined;
}

export function sessionTranscriptPath(stateDir, turn) {
  const agentId = safePathSegment(turn?.agentId ?? "main");
  const sessionId = safePathSegment(turn?.sessionId);
  if (typeof stateDir !== "string" || !stateDir || !agentId || !sessionId) return undefined;
  const sessionsDir = path.resolve(stateDir, "agents", agentId, "sessions");
  const transcript = path.resolve(sessionsDir, `${sessionId}.jsonl`);
  if (!transcript.startsWith(`${sessionsDir}${path.sep}`)) return undefined;
  return transcript;
}

async function regularTranscriptStat(stateDir, transcript) {
  const root = path.resolve(stateDir);
  const relative = path.relative(root, transcript);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;

  // lstat every derived component below the configured state root. Checking
  // only the final file would still allow an `agents` or `sessions` symlink to
  // redirect the read outside the LobsterAI state tree.
  let current = root;
  let stat;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return undefined;
  }
  if (!stat?.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return undefined;
  return stat;
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function finishReason(stopReason) {
  const normalized = String(stopReason ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return undefined;
  if (["tooluse", "tool_use", "tool_call", "tool_calls"].includes(normalized)) return "tool_call";
  if (["stop", "end_turn", "complete", "completed"].includes(normalized)) return "stop";
  if (["cancel", "canceled", "cancelled", "abort", "aborted", "interrupt", "interrupted"].includes(normalized)) {
    return "cancelled";
  }
  return normalized;
}

function contentConfig(config) {
  return {
    ...config,
    maxChars: config.captureContent === "preview"
      ? Math.min(config.maxChars ?? 2000, 2000)
      : config.maxChars
  };
}

function normalizedPart(item, config) {
  if (!item || typeof item !== "object") return undefined;
  const limited = contentConfig(config);
  if (item.type === "thinking" && typeof item.thinking === "string") {
    const captured = captureText(item.thinking, limited);
    return captured.value ? { type: "reasoning", content: captured.value } : undefined;
  }
  if (item.type === "text" && typeof item.text === "string") {
    const captured = captureText(item.text, limited);
    return captured.value ? { type: "text", content: captured.value } : undefined;
  }
  if (item.type === "toolCall") {
    const id = typeof item.id === "string" ? captureText(item.id, limited).value : undefined;
    const name = typeof item.name === "string" ? captureText(item.name, limited).value : undefined;
    const rawArguments = item.arguments ?? item.partialArgs;
    return {
      type: "tool_call",
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(rawArguments !== undefined ? { arguments: sanitizeValue(rawArguments, limited) } : {})
    };
  }
  return undefined;
}

function assistantRecord(record, config) {
  const message = record?.message;
  if (!message || message.role !== "assistant") return undefined;
  // LobsterAI records the model-call start on `message.timestamp`, while the
  // outer transcript record is flushed immediately before model_call_ended.
  // Match the response to the hook end using that outer timestamp. Older
  // transcript variants without a usable outer timestamp retain the original
  // message-timestamp fallback.
  const timeMs = timestampMs(record.timestamp) ?? timestampMs(message.timestamp);
  if (timeMs === undefined) return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const textItems = content.filter((item) => item?.type === "text" && typeof item.text === "string");
  const toolItems = content.filter((item) => item?.type === "toolCall");
  const rawText = textItems.map((item) => item.text).join("\n");
  const toolNames = toolItems
    .map((item) => typeof item.name === "string" ? item.name.trim() : "")
    .filter(Boolean);
  const previewSource = rawText || (toolNames.length ? `tool_call: ${toolNames.join(", ")}` : "");
  const capturedPreview = captureText(previewSource, config);
  const parts = config.captureContent === "none"
    ? undefined
    : content.map((item) => normalizedPart(item, config)).filter(Boolean);
  return {
    timeMs,
    provider: typeof message.provider === "string" ? message.provider : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    responseId: typeof message.responseId === "string" ? message.responseId : undefined,
    usage: message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? { ...message.usage }
      : undefined,
    finishReasons: [finishReason(message.stopReason)].filter(Boolean),
    outputKind: toolItems.length ? "tool_call" : "text",
    output: capturedPreview.value,
    outputLength: capturedPreview.length,
    outputMessage: parts?.length ? { role: "assistant", parts } : undefined,
    hasText: rawText.length > 0,
    hasToolCall: toolItems.length > 0
  };
}

function callWindowContains(call, recordTime) {
  const start = finite(call.startMs);
  const end = finite(call.endMs);
  if (start === undefined || end === undefined) return false;
  return recordTime >= start &&
    recordTime <= end + CALL_CLOCK_TOLERANCE_MS &&
    Math.abs(end - recordTime) <= CALL_END_TOLERANCE_MS;
}

export function matchAssistantRecords(turn, records) {
  const calls = (turn.llmCalls ?? [])
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => finite(call.startMs) !== undefined && finite(call.endMs) !== undefined)
    .sort((left, right) => left.call.endMs - right.call.endMs || left.index - right.index);
  const candidates = records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => left.record.timeMs - right.record.timeMs || left.index - right.index);

  // Assign a record only when this call is its unique nearest eligible hook
  // end. A missing transcript record therefore cannot shift all later records
  // onto earlier calls.
  const nearestCallByRecord = new Map();
  for (const candidate of candidates) {
    const eligible = calls
      .filter(({ call }) => callWindowContains(call, candidate.record.timeMs))
      .map((entry) => ({ ...entry, distance: Math.abs(entry.call.endMs - candidate.record.timeMs) }))
      .sort((left, right) => left.distance - right.distance || left.index - right.index);
    if (!eligible.length) continue;
    if (eligible.length > 1 && eligible[0].distance === eligible[1].distance) continue;
    nearestCallByRecord.set(candidate.index, eligible[0].index);
  }

  const matches = [];
  const usedRecords = new Set();
  let previousRecordTime = -Infinity;
  for (const { call, index: callIndex } of calls) {
    const eligible = candidates
      .filter(({ record, index }) => !usedRecords.has(index) &&
        record.timeMs >= previousRecordTime &&
        nearestCallByRecord.get(index) === callIndex)
      .sort((left, right) => {
        const leftDistance = Math.abs(call.endMs - left.record.timeMs);
        const rightDistance = Math.abs(call.endMs - right.record.timeMs);
        return leftDistance - rightDistance || left.record.timeMs - right.record.timeMs;
      });
    if (!eligible.length) continue;
    if (eligible.length > 1) {
      const firstDistance = Math.abs(call.endMs - eligible[0].record.timeMs);
      const secondDistance = Math.abs(call.endMs - eligible[1].record.timeMs);
      // Equal nearest records are ambiguous (for example a duplicate flush at
      // the same timestamp). Preserve hook-only data instead of picking by
      // file order and potentially attaching another response to this call.
      if (firstDistance === secondDistance) continue;
    }
    const selected = eligible[0];
    usedRecords.add(selected.index);
    previousRecordTime = selected.record.timeMs;
    matches.push({ call, record: selected.record });
  }
  return matches;
}

function applyRecord(call, record) {
  call.provider = record.provider ?? call.provider;
  call.responseModel = record.model ?? call.responseModel ?? call.model;
  call.model ??= record.model;
  call.responseId = record.responseId ?? call.responseId;
  call.usage = record.usage ?? call.usage;
  call.finishReasons = record.finishReasons.length ? record.finishReasons : call.finishReasons;
  call.outputKind = record.outputKind;
  call.output = record.output;
  call.outputLength = record.outputLength;
  call.outputMessage = record.outputMessage;
  call.transcriptTimeMs = record.timeMs;
}

export async function readAndEnrichTranscript(stateDir, turn, config) {
  const transcript = sessionTranscriptPath(stateDir, turn);
  if (!transcript) return { matched: 0, sessionCreateMs: undefined };
  let expectedStat;
  try {
    expectedStat = await regularTranscriptStat(stateDir, transcript);
    if (!expectedStat) {
      return { matched: 0, sessionCreateMs: undefined };
    }
  } catch {
    return { matched: 0, sessionCreateMs: undefined };
  }

  const turnStart = finite(turn?.startMs);
  const turnEnd = finite(turn?.endMs);
  const lower = turnStart === undefined ? undefined : turnStart - TURN_WINDOW_TOLERANCE_MS;
  const upper = turnEnd === undefined ? undefined : turnEnd + TURN_WINDOW_TOLERANCE_MS;
  const maxRetained = Math.max(MIN_RETAINED_RECORDS, (turn?.llmCalls?.length ?? 0) * MAX_RETAINED_RECORD_FACTOR);
  const records = [];
  let sessionCreateMs;
  let headerValidated = false;
  let overflow = false;
  let handle;
  let stream;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(transcript, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_TRANSCRIPT_BYTES || !sameFile(expectedStat, openedStat)) {
      return { matched: 0, sessionCreateMs: undefined };
    }
    stream = handle.createReadStream({
      encoding: "utf8",
      highWaterMark: 64 * 1024,
      autoClose: false,
      end: MAX_TRANSCRIPT_BYTES - 1
    });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A partially flushed or malformed line is ignored. Other complete
        // records can still safely enrich the terminal turn.
        continue;
      }
      if (!headerValidated) {
        if (record?.type !== "session" || record.id !== turn.sessionId) {
          lines.close();
          return { matched: 0, sessionCreateMs: undefined };
        }
        headerValidated = true;
        sessionCreateMs = timestampMs(record.timestamp ?? record.createdAt ?? record.created_at);
        continue;
      }
      const assistant = assistantRecord(record, config);
      if (!assistant) continue;
      if (lower !== undefined && assistant.timeMs < lower) continue;
      if (upper !== undefined && assistant.timeMs > upper) continue;
      if (records.length >= maxRetained) {
        overflow = true;
        continue;
      }
      records.push(assistant);
    }
  } catch {
    return { matched: 0, sessionCreateMs };
  } finally {
    stream?.destroy();
    await handle?.close().catch(() => {});
  }
  if (!headerValidated || overflow) return { matched: 0, sessionCreateMs };

  const matches = matchAssistantRecords(turn, records);
  for (const { call, record } of matches) applyRecord(call, record);
  return {
    matched: matches.length,
    sessionCreateMs,
    finalText: [...matches]
      .reverse()
      .find(({ record }) => record.hasText && !record.hasToolCall && record.finishReasons.includes("stop"))
      ?.record.output
  };
}

export const __transcriptTest = {
  TURN_WINDOW_TOLERANCE_MS,
  CALL_CLOCK_TOLERANCE_MS,
  CALL_END_TOLERANCE_MS,
  MAX_TRANSCRIPT_BYTES,
  finishReason,
  matchAssistantRecords
};
