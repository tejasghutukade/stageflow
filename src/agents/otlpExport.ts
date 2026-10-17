import { redactSecrets } from "../agent/streamLogRedact.js";
import type { AgentSpan, AgentTurn } from "./store.js";

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };

function attribute(key: string, value: unknown): OtlpAttribute | undefined {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return undefined;
}

function unixNanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
}

const STATUS_CODE = { ok: 1, error: 2, cancelled: 2 } as Record<string, number>;

function spanAttributes(span: AgentSpan): OtlpAttribute[] {
  const attrs: Array<OtlpAttribute | undefined> = [
    attribute("gen_ai.operation.name", span.name),
    attribute("stageflow.span.kind", span.kind),
    span.inputTokens !== null ? attribute("gen_ai.usage.input_tokens", span.inputTokens) : undefined,
    span.outputTokens !== null ? attribute("gen_ai.usage.output_tokens", span.outputTokens) : undefined,
    ...Object.entries(span.attributes).map(([key, value]) => attribute(key, value)),
    // Bodies were redacted when stored; redact again so a future store path can't leak through export.
    span.inputText !== null ? attribute("gen_ai.input.messages", redactSecrets(span.inputText)) : undefined,
    span.outputText !== null ? attribute("gen_ai.output.messages", redactSecrets(span.outputText)) : undefined,
  ];
  return attrs.filter((item): item is OtlpAttribute => item !== undefined);
}

/** OTLP/JSON `ExportTraceServiceRequest` for the given turns. */
export function exportTurnsToOtlp(
  turns: Array<{ turn: AgentTurn; spans: AgentSpan[] }>,
  resource: { serviceName: string; agentId: string },
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", resource.serviceName),
            attribute("gen_ai.agent.name", resource.agentId),
          ].filter(Boolean),
        },
        scopeSpans: [
          {
            scope: { name: "stageflow.agents" },
            spans: turns.flatMap(({ turn, spans }) =>
              spans.map((span) => ({
                traceId: turn.traceId,
                spanId: span.id,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                startTimeUnixNano: unixNanos(span.startedAt),
                endTimeUnixNano: unixNanos(span.endedAt ?? span.startedAt),
                status: { code: STATUS_CODE[span.status] ?? 0 },
                attributes: spanAttributes(span),
              })),
            ),
          },
        ],
      },
    ],
  };
}
