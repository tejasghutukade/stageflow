import { describe, expect, it } from "vitest";
import { exportTurnsToOtlp } from "../src/agents/otlpExport.js";
import type { AgentTurn } from "../src/agents/store.js";
import { prepareSpan } from "../src/agents/trace.js";

const turn: AgentTurn = {
  id: "turn_1",
  sessionId: "ses_1",
  seq: 1,
  revision: 3,
  traceId: "4bf92f3577b34da6a3ce929d0e0e9cd1",
  status: "succeeded",
  errorCode: null,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: null,
  startedAt: "2026-10-15T12:00:00.000Z",
  endedAt: "2026-10-15T12:00:02.000Z",
};

const draft = {
  turnId: "turn_1",
  name: "chat",
  kind: "model" as const,
  status: "ok" as const,
  startedAt: new Date("2026-10-15T12:00:00.000Z"),
  endedAt: new Date("2026-10-15T12:00:01.500Z"),
  usage: { inputTokens: 10, outputTokens: 5 },
  attributes: { "gen_ai.request.model": "openai/gpt-5" },
  input: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  output: "fine",
};

describe("agent trace capture and export", () => {
  it("applies the capture mode before storage", () => {
    expect(prepareSpan("off", draft)).toBeNull();
    expect(prepareSpan("metadata", draft)).toMatchObject({ durationMs: 1500, inputText: null, outputText: null });
    const full = prepareSpan("full", draft)!;
    expect(full.outputText).toBe("fine");
    expect(full.inputText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("exports OTLP/JSON with trace ids, nanosecond times, usage and GenAI attributes", () => {
    const span = prepareSpan("full", draft)!;
    const exported = exportTurnsToOtlp([{ turn, spans: [span] }], { serviceName: "stageflow-agent-runtime", agentId: "lead" });
    const resourceSpans = (exported.resourceSpans as Array<Record<string, any>>)[0]!;
    expect(resourceSpans.resource.attributes).toContainEqual({ key: "gen_ai.agent.name", value: { stringValue: "lead" } });
    const out = resourceSpans.scopeSpans[0].spans[0];
    expect(out).toMatchObject({
      traceId: turn.traceId,
      spanId: span.id,
      name: "chat",
      startTimeUnixNano: "1792065600000000000",
      endTimeUnixNano: "1792065601500000000",
      status: { code: 1 },
    });
    expect(out.attributes).toEqual(
      expect.arrayContaining([
        { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
        { key: "gen_ai.request.model", value: { stringValue: "openai/gpt-5" } },
        { key: "gen_ai.output.messages", value: { stringValue: "fine" } },
      ]),
    );
  });
});
