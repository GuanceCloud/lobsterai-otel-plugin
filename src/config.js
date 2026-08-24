const DEFAULT_GTRACE_ENDPOINT = "https://llm-openway.guance.com";
const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:4318";
const FORBIDDEN_RESOURCE_KEY = /(session|turn|run|request|message|prompt|input|output|content|path|command|result|stack|url)/i;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

export function parseOtelHeaders(value) {
  if (!value || typeof value !== "string") return {};
  const result = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = decodeURIComponent(part.slice(0, separator).trim());
    const headerValue = decodeURIComponent(part.slice(separator + 1).trim());
    if (key && headerValue) result[key] = headerValue;
  }
  return result;
}

function stringHeaders(value) {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([key, item]) => key.trim() && typeof item === "string" && item.trim())
      .map(([key, item]) => [key.trim(), item.trim()])
  );
}

function resourceAttributes(value) {
  return Object.fromEntries(
    Object.entries(record(value)).filter(([key, item]) => {
      return key.trim() && !FORBIDDEN_RESOURCE_KEY.test(key) &&
        (typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    })
  );
}

function normalizeBaseUrl(value) {
  return nonEmpty(value)?.replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  return (nonEmpty(value) ?? fallback).replace(/^\/+/, "");
}

export function joinUrl(endpoint, path) {
  const base = normalizeBaseUrl(endpoint);
  if (!base) return undefined;
  return `${base}/${normalizePath(path, "")}`.replace(/\/+$/, "");
}

export function resolveConfig(rawValue = {}, env = {}) {
  const raw = record(rawValue);
  const profile = raw.profile === "otlp" ? "otlp" : "gtrace";
  const defaultEndpoint = profile === "gtrace" ? DEFAULT_GTRACE_ENDPOINT : DEFAULT_OTLP_ENDPOINT;
  const endpoint = normalizeBaseUrl(nonEmpty(raw.endpoint) ?? nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? defaultEndpoint);
  const tracePath = normalizePath(raw.tracePath, profile === "gtrace" ? "v1/write/otel-llm" : "v1/traces");
  const metricsPath = normalizePath(raw.metricsPath, profile === "gtrace" ? "v1/write/otel-metrics" : "v1/metrics");
  const headers = {
    ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...stringHeaders(raw.headers)
  };
  const xToken = nonEmpty(raw.xToken);
  if (xToken && !Object.keys(headers).some((key) => key.toLowerCase() === "x-token")) {
    headers["X-Token"] = xToken;
  }
  if (profile === "gtrace" && !Object.keys(headers).some((key) => key.toLowerCase() === "to-headless")) {
    headers["To-Headless"] = "true";
  }

  const captureContent = ["none", "preview", "full"].includes(raw.captureContent)
    ? raw.captureContent
    : "preview";
  const timeoutMs = numberInRange(raw.timeoutMs ?? env.OTEL_EXPORTER_OTLP_TIMEOUT, 25_000, 1000, 60_000);
  const configuredResource = resourceAttributes(raw.resourceAttributes);

  return {
    enabled: raw.enabled === true,
    profile,
    endpoint,
    tracesUrl: normalizeBaseUrl(nonEmpty(raw.tracesUrl) ?? nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) ?? joinUrl(endpoint, tracePath),
    metricsUrl: normalizeBaseUrl(nonEmpty(raw.metricsUrl) ?? nonEmpty(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)) ?? joinUrl(endpoint, metricsPath),
    tracePath,
    metricsPath,
    headers,
    captureContent,
    maxChars: numberInRange(raw.maxChars, 2000, 128, 100_000),
    timeoutMs,
    debug: raw.debug === true,
    internalRequestPolicy: raw.internalRequestPolicy === "export" ? "export" : "drop",
    claimTtlMs: numberInRange(raw.claimTtlMs, 120_000, 10_000, 600_000),
    retryIntervalMs: numberInRange(raw.retryIntervalMs, 60_000, 5_000, 600_000),
    retentionDays: numberInRange(raw.retentionDays, 7, 1, 90),
    stateDir: nonEmpty(raw.stateDir) ?? nonEmpty(env.LOBSTERAI_OTEL_STATE_DIR),
    resourceAttributes: {
      "service.name": "lobsterai",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.name": "lobsterai-otel-plugin",
      "telemetry.sdk.version": "0.1.0",
      agent_id: "main",
      agent_name: "LobsterAI",
      agent_runtime: "lobsterai",
      ...configuredResource
    }
  };
}

export const __configTest = { resourceAttributes };
