import { describe, expect, it, vi } from "vitest";
import { parseAskOperatorParams } from "../src/tools/askOperator.js";
import { createAskOperatorTool } from "../src/tools/askOperator.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import {
  prepareAskOperatorArguments,
  prepareEmitStageEnvelopeArguments,
} from "../src/tools/prepareToolArguments.js";

describe("prepareAskOperatorArguments", () => {
  it("parses stringified artifact_backed artifacts from OpenRouter completions", () => {
    const out = prepareAskOperatorArguments({
      kind: "artifact_backed",
      message: "Please review requirements.md and accept or reject.",
      artifacts:
        '["stages/brainstorm/attempts/4/artifacts/requirements.md"]',
    });
    expect(out).toEqual({
      kind: "artifact_backed",
      message: "Please review requirements.md and accept or reject.",
      artifacts: ["stages/brainstorm/attempts/4/artifacts/requirements.md"],
    });
  });

  it("parses stringified multi_question questions", () => {
    const out = prepareAskOperatorArguments({
      kind: "multi_question",
      questions:
        '[{"kind":"free_text","message":"Name?","id":"q-name"}]',
    });
    expect(out).toEqual({
      kind: "multi_question",
      questions: [{ kind: "free_text", message: "Name?", id: "q-name" }],
    });
  });

  it("parses stringified objects inside a questions array", () => {
    const out = prepareAskOperatorArguments({
      kind: "multi_question",
      questions: ['{"kind":"free_text","message":"Name?","id":"q-name"}'],
    });
    expect(out).toEqual({
      kind: "multi_question",
      questions: [{ kind: "free_text", message: "Name?", id: "q-name" }],
    });
  });

  it("leaves non-array JSON strings untouched", () => {
    const input = {
      kind: "artifact_backed",
      message: "Review",
      artifacts: "requirements.md",
    };
    expect(prepareAskOperatorArguments(input)).toEqual(input);
  });

  it("does not mutate the input object", () => {
    const input = {
      kind: "artifact_backed",
      message: "Review",
      artifacts: '["requirements.md"]',
    };
    prepareAskOperatorArguments(input);
    expect(input.artifacts).toBe('["requirements.md"]');
  });
});

describe("prepareEmitStageEnvelopeArguments", () => {
  it("parses stringified artifacts and nested checklist items", () => {
    const out = prepareEmitStageEnvelopeArguments({
      status: "success",
      summary: "done",
      artifacts: '["stages/brainstorm/attempts/4/artifacts/requirements.md"]',
      fork_choice: '["review~1"]',
      checklist_attestations: [
        {
          check_id: "join-checklist",
          items: '["All persona reports read","Blockers deduplicated"]',
        },
      ],
    });
    expect(out).toEqual({
      status: "success",
      summary: "done",
      artifacts: ["stages/brainstorm/attempts/4/artifacts/requirements.md"],
      fork_choice: ["review~1"],
      checklist_attestations: [
        {
          check_id: "join-checklist",
          items: ["All persona reports read", "Blockers deduplicated"],
        },
      ],
    });
  });

  it("parses stringified payload and feedback_loop objects", () => {
    const out = prepareEmitStageEnvelopeArguments({
      status: "success",
      summary: "The implementation has 1 blocking finding.",
      artifacts: ["stages/join-review/attempts/1/artifacts/joined-review.md"],
      payload:
        '{"verdict":"changes_required","blocking_findings":["diagram visualization"],"remaining_risks":[],"changed_files":["src/cli.ts"]}',
      feedback_loop: '{"action":"send_back","target":"implement"}',
    });
    expect(out).toEqual({
      status: "success",
      summary: "The implementation has 1 blocking finding.",
      artifacts: ["stages/join-review/attempts/1/artifacts/joined-review.md"],
      payload: {
        verdict: "changes_required",
        blocking_findings: ["diagram visualization"],
        remaining_risks: [],
        changed_files: ["src/cli.ts"],
      },
      feedback_loop: { action: "send_back", target: "implement" },
    });
  });

  it("parses stringified objects inside checklist_attestations", () => {
    const out = prepareEmitStageEnvelopeArguments({
      status: "success",
      summary: "done",
      artifacts: [],
      checklist_attestations: [
        '{"check_id":"join-checklist","items":["All persona reports read"]}',
      ],
    });
    expect(out).toEqual({
      status: "success",
      summary: "done",
      artifacts: [],
      checklist_attestations: [
        {
          check_id: "join-checklist",
          items: ["All persona reports read"],
        },
      ],
    });
  });

  it("leaves non-object JSON strings on payload and feedback_loop untouched", () => {
    const input = {
      status: "success",
      summary: "done",
      artifacts: [],
      payload: "not-json",
      feedback_loop: "send_back",
    };
    expect(prepareEmitStageEnvelopeArguments(input)).toEqual(input);
  });
});

describe("parseAskOperatorParams stringified arrays", () => {
  it("accepts stringified artifacts", () => {
    expect(
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Review requirements.md",
        artifacts: '["requirements.md"]',
      }),
    ).toEqual({
      kind: "artifact_backed",
      message: "Review requirements.md",
      artifacts: ["requirements.md"],
    });
  });

  it("still rejects a bare path string", () => {
    expect(() =>
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Review",
        artifacts: "requirements.md",
      }),
    ).toThrow(/artifacts must be an array/);
  });

  it("accepts stringified objects inside questions", () => {
    expect(
      parseAskOperatorParams({
        kind: "multi_question",
        questions: ['{"kind":"free_text","message":"Name?","id":"q-name"}'],
      }),
    ).toEqual({
      kind: "multi_question",
      questions: [{ kind: "free_text", message: "Name?", id: "q-name" }],
    });
  });
});

describe("tool prepareArguments hooks", () => {
  it("ask_operator prepareArguments is wired", () => {
    const tool = createAskOperatorTool({
      requestWait: vi.fn(async () => ({
        promptId: "x",
        kind: "confirm",
        decision: "accept",
      })),
    });
    expect(tool.prepareArguments).toBeTypeOf("function");
    const prepared = tool.prepareArguments?.({
      kind: "artifact_backed",
      message: "Review",
      artifacts: '["requirements.md"]',
    });
    expect(prepared).toMatchObject({
      artifacts: ["requirements.md"],
    });
  });

  it("emit_stage_envelope accepts stringified artifacts in execute", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    expect(tool.prepareArguments).toBeTypeOf("function");
    const result = await tool.execute("1", {
      status: "success",
      summary: "requirements accepted",
      artifacts: '["stages/brainstorm/attempts/4/artifacts/requirements.md"]',
      payload: { ok: true },
    });
    expect(result.isError).toBeUndefined();
    expect(capture).toMatchObject({
      envelope: {
        artifacts: ["stages/brainstorm/attempts/4/artifacts/requirements.md"],
      },
    });
  });

  it("emit_stage_envelope accepts stringified payload and feedback_loop in execute", async () => {
    const capture: { envelope?: { payload?: unknown; feedback_loop?: unknown } } =
      {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        target: "implement",
        max_replays: 2,
        on_max_replays: "require_continue",
        replay_session: "resume",
      },
    );
    const prepared = tool.prepareArguments?.({
      status: "success",
      summary: "The implementation has 1 blocking finding.",
      artifacts: ["stages/join-review/attempts/1/artifacts/joined-review.md"],
      payload:
        '{"verdict":"changes_required","blocking_findings":["diagram visualization"]}',
      feedback_loop: '{"action":"send_back","target":"implement"}',
    });
    expect(prepared).toMatchObject({
      payload: {
        verdict: "changes_required",
        blocking_findings: ["diagram visualization"],
      },
      feedback_loop: { action: "send_back", target: "implement" },
    });
    const result = await tool.execute("1", {
      status: "success",
      summary: "The implementation has 1 blocking finding.",
      artifacts: ["stages/join-review/attempts/1/artifacts/joined-review.md"],
      payload:
        '{"verdict":"changes_required","blocking_findings":["diagram visualization"]}',
      feedback_loop: '{"action":"send_back","target":"implement"}',
    });
    expect(result.isError).toBeUndefined();
    expect(capture.envelope?.feedback_loop).toEqual({
      action: "send_back",
      target: "implement",
    });
    expect(capture.envelope?.payload).toEqual({
      verdict: "changes_required",
      blocking_findings: ["diagram visualization"],
    });
  });
});
