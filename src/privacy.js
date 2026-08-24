const SENSITIVE_KEY = /(authorization|cookie|secret|token|password|passwd|api[-_]?key|private[-_]?key|client[-_]?secret|x[-_]?token)/i;
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redactText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(/(["']?(?:authorization|cookie|secret|token|password|api[-_]?key|x[-_]?token)["']?\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[REDACTED]");
  return text;
}

function crop(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}

export function sanitizeValue(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 6;
  const maxArray = options.maxArray ?? 50;
  const maxChars = options.maxChars ?? 2000;
  if (depth > maxDepth) return "[TRUNCATED_DEPTH]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return crop(redactText(value), maxChars);
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => sanitizeValue(item, options, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, maxArray)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item, options, depth + 1);
    }
    return result;
  }
  return crop(redactText(String(value)), maxChars);
}

export function captureText(value, config) {
  const source = typeof value === "string" ? value : value == null ? "" : JSON.stringify(sanitizeValue(value, config));
  const redacted = redactText(source);
  const length = redacted.length;
  if (config.captureContent === "none") return { length };
  const limit = config.captureContent === "preview" ? Math.min(config.maxChars, 2000) : config.maxChars;
  return { value: crop(redacted, limit), length };
}

export function safeJson(value, config) {
  if (config.captureContent === "none") return undefined;
  return JSON.stringify(sanitizeValue(value, config));
}
