import { ProtobufMetricsSerializer, ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";

export function serializeSignals(spans, resourceMetrics) {
  return {
    traces: Buffer.from(ProtobufTraceSerializer.serializeRequest(spans)),
    metrics: Buffer.from(ProtobufMetricsSerializer.serializeRequest(resourceMetrics))
  };
}

function rejectedCount(signal, decoded) {
  const partial = decoded?.partialSuccess ?? decoded?.partial_success;
  if (!partial) return 0;
  return signal === "traces"
    ? Number(partial.rejectedSpans ?? partial.rejected_spans ?? 0)
    : Number(partial.rejectedDataPoints ?? partial.rejected_data_points ?? 0);
}

function safeHeaders(headers) {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "content-type") delete result[key];
  }
  result["content-type"] = "application/x-protobuf";
  return result;
}

export async function uploadSignal({ signal, url, body, config, fetchImpl = fetch }) {
  if (!url) throw new Error(`${signal} endpoint is not configured`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${signal} upload timed out`)), config.timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: safeHeaders(config.headers),
      body,
      signal: controller.signal
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`${signal} upload failed with HTTP ${response.status}`);
    if (responseBody.length) {
      const decoded = signal === "traces"
        ? ProtobufTraceSerializer.deserializeResponse(responseBody)
        : ProtobufMetricsSerializer.deserializeResponse(responseBody);
      const rejected = rejectedCount(signal, decoded);
      if (rejected > 0) throw new Error(`${signal} receiver rejected ${rejected} items`);
    }
    return { status: response.status, bytes: body.length };
  } finally {
    clearTimeout(timeout);
  }
}

export const __otlpTest = { rejectedCount, safeHeaders };
