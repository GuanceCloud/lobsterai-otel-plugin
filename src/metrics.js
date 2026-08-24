import { ValueType } from "@opentelemetry/api";
import { AggregationTemporality, DataPointType } from "@opentelemetry/sdk-metrics";

const WORKFLOW_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];
const OPERATION_BUCKETS = [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960, 81920];
const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

function metricAttrs(attrs, keys) {
  return Object.fromEntries(keys.map((key) => [key, attrs[key]]).filter(([, value]) => value !== undefined && value !== ""));
}

function bucketCounts(value, boundaries) {
  const counts = Array(boundaries.length + 1).fill(0);
  const index = boundaries.findIndex((boundary) => value <= boundary);
  counts[index === -1 ? boundaries.length : index] = 1;
  return counts;
}

function histogramPoint(span, value, boundaries, attrs) {
  return {
    attributes: attrs,
    startTime: span.startTime,
    endTime: span.endTime,
    value: {
      min: value,
      max: value,
      sum: value,
      count: 1,
      buckets: { boundaries, counts: bucketCounts(value, boundaries) }
    }
  };
}

function singularPoint(span, value, attrs) {
  return { attributes: attrs, startTime: span.startTime, endTime: span.endTime, value };
}

function descriptor(name, unit, valueType) {
  return { name, description: "", unit, valueType, advice: {} };
}

export function deriveMetrics(spans) {
  const root = spans.find((span) => span.name === "invoke_agent");
  if (!root || root.attributes.final_status === "unset") return undefined;
  const scope = root.instrumentationScope;
  const operationSpans = spans.filter((span) => span.name === "llm" || span.name.startsWith("tool:") || span.name.startsWith("skill:"));
  const workflowStatus = root.attributes.status === "error" ? "error" : "completed";
  const workflow = {
    descriptor: descriptor("gen_ai.workflow.duration", "s", ValueType.DOUBLE),
    aggregationTemporality: AggregationTemporality.DELTA,
    dataPointType: DataPointType.HISTOGRAM,
    dataPoints: [histogramPoint(root, root.durationMs / 1000, WORKFLOW_BUCKETS, {
      final_status: root.attributes.final_status,
      status: workflowStatus
    })]
  };

  const countPoints = [];
  const durationPoints = [];
  const tokenPoints = [];
  for (const span of operationSpans) {
    const attrs = span.attributes;
    const status = attrs.status === "error" ? "error" : "ok";
    const operationAttrs = metricAttrs({ ...attrs, status }, [
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.response.model",
      "gen_ai.tool.name",
      "gen_ai.skill.name",
      "status",
      "error.type"
    ]);
    countPoints.push(singularPoint(span, 1, operationAttrs));
    durationPoints.push(histogramPoint(span, span.durationMs, OPERATION_BUCKETS, operationAttrs));
    if (span.name === "llm") {
      const tokenAttrs = metricAttrs(attrs, ["gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model"]);
      for (const [type, key] of [["input", "gen_ai.usage.input_tokens"], ["output", "gen_ai.usage.output_tokens"]]) {
        const value = attrs[key];
        if (typeof value === "number" && value > 0) {
          tokenPoints.push(histogramPoint(span, value, TOKEN_BUCKETS, { ...tokenAttrs, "gen_ai.token.type": type }));
        }
      }
    }
  }

  const metrics = [workflow];
  if (countPoints.length) {
    metrics.push({
      descriptor: descriptor("gen_ai.agent.operation.count", "-", ValueType.INT),
      aggregationTemporality: AggregationTemporality.DELTA,
      dataPointType: DataPointType.SUM,
      isMonotonic: true,
      dataPoints: countPoints
    });
    metrics.push({
      descriptor: descriptor("gen_ai.agent.operation.duration", "ms", ValueType.DOUBLE),
      aggregationTemporality: AggregationTemporality.DELTA,
      dataPointType: DataPointType.HISTOGRAM,
      dataPoints: durationPoints
    });
  }
  if (tokenPoints.length) {
    metrics.push({
      descriptor: descriptor("gen_ai.client.token.usage", "{token}", ValueType.DOUBLE),
      aggregationTemporality: AggregationTemporality.DELTA,
      dataPointType: DataPointType.HISTOGRAM,
      dataPoints: tokenPoints
    });
  }
  return { resource: root.resource, scopeMetrics: [{ scope, metrics }] };
}

export const __metricTest = { bucketCounts, WORKFLOW_BUCKETS, OPERATION_BUCKETS, TOKEN_BUCKETS };
