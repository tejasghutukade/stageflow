import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
  createAttemptQaTrailReader,
  type QaExchange,
} from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { AskOperatorAnswer, AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { PreEmitCheck } from "../src/types/preEmitCheck.js";
import type { StageGateKind } from "../src/types/stage.js";

const approvedSuccess = {
  status: "success" as const,
  summary: "plan accepted",
  artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"],
  payload: { approved: true },
};

const artifactPrompt: AskOperatorPrompt = {
  kind: "artifact_backed",
  id: "ae2-plan-review",
  message: "Review the plan artifact",
  artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"],
};

function artifactAnswer(decision: "accept" | "reject"): AskOperatorAnswer {
  return {
    promptId: artifactPrompt.id,
    kind: "artifact_backed",
    decision,
  };
}

function confirmPrompt(id: string): AskOperatorPrompt {
  return { kind: "confirm", id, message: "Proceed?" };
}

function confirmAnswer(
  id: string,
  decision: "accept" | "reject",
): AskOperatorAnswer {
  return { promptId: id, kind: "confirm", decision };
}

function freeTextExchange(answered: boolean): QaExchange {
  const prompt: AskOperatorPrompt = {
    kind: "free_text",
    id: "ft-1",
    message: "Module name?",
  };
  return {
    prompt,
    answer: answered
      ? { promptId: "ft-1", kind: "free_text", text: "billing" }
      : null,
  };
}

function multiQuestionExchange(): QaExchange {
  return {
    prompt: {
      kind: "multi_question",
      id: "mq-1",
      questions: [{ id: "q-module", kind: "free_text", message: "Module?" }],
    },
    answer: {
      promptId: "mq-1",
      kind: "multi_question",
      answers: {
        "q-module": { kind: "free_text", text: "billing" },
      },
    },
  };
}

function gateCheck(kind: StageGateKind): PreEmitCheck {
  return { id: `gate-${kind}`, type: "gate", kind };
}

async function emitSuccess(
  tool: ReturnType<typeof createEmitStageEnvelopeTool>,
  extra: Record<string, unknown> = {},
) {
  return tool.execute("emit-1", { ...approvedSuccess, ...extra });
}

describe("emit_stage_envelope pre_emit_checks: gate", () => {
  it("artifact_backed success with zero QA events is rejected", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => [],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("last decision reject rejects success emit", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => [
          { prompt: artifactPrompt, answer: artifactAnswer("reject") },
        ],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("reject then accept then success emit is accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => [
          { prompt: artifactPrompt, answer: artifactAnswer("reject") },
          { prompt: artifactPrompt, answer: artifactAnswer("accept") },
        ],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("two asks of the same kind: only the last decision matters", async () => {
    const acceptThenReject = {};
    const acceptThenRejectTool = createEmitStageEnvelopeTool(
      acceptThenReject,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("confirm")],
        readQaTrail: () => [
          { prompt: confirmPrompt("c1"), answer: confirmAnswer("c1", "accept") },
          { prompt: confirmPrompt("c2"), answer: confirmAnswer("c2", "reject") },
        ],
      },
    );
    const rejected = await acceptThenRejectTool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(rejected.isError).toBe(true);
    expect(acceptThenReject).not.toHaveProperty("envelope");

    const rejectThenAccept = {};
    const rejectThenAcceptTool = createEmitStageEnvelopeTool(
      rejectThenAccept,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("confirm")],
        readQaTrail: () => [
          { prompt: confirmPrompt("c1"), answer: confirmAnswer("c1", "reject") },
          { prompt: confirmPrompt("c2"), answer: confirmAnswer("c2", "accept") },
        ],
      },
    );
    const accepted = await rejectThenAcceptTool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(accepted.isError).toBeUndefined();
    expect(accepted.terminate).toBe(true);
    expect(rejectThenAccept).toHaveProperty("envelope");
  });

  it("free_text declared: any completed answer satisfies without decision", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("free_text")],
        readQaTrail: () => [freeTextExchange(true)],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("free_text declared: pending-only does not satisfy", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("free_text")],
        readQaTrail: () => [freeTextExchange(false)],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("multi_question declared: any completed answer satisfies", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("multi_question")],
        readQaTrail: () => [multiQuestionExchange()],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(capture).toHaveProperty("envelope");
  });

  it("omitted pre_emit_checks may emit success with no QA events", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const result = await emitSuccess(tool);
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("empty checks list skips completion even when a reader is present", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [],
        readQaTrail: () => [],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBeUndefined();
    expect(capture).toHaveProperty("envelope");
  });

  it("failure envelopes skip the declared-gate check", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => [],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toMatchObject({ envelope: { status: "failure" } });
  });

  it("gate check without a reader fails closed on success", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      { checks: [gateCheck("artifact_backed")] },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("reads the trail inside execute, not at factory time", async () => {
    const exchanges: QaExchange[] = [];
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => exchanges,
      },
    );
    const before = await emitSuccess(tool);
    expect(before.isError).toBe(true);
    expect(capture).not.toHaveProperty("envelope");

    exchanges.push({
      prompt: artifactPrompt,
      answer: artifactAnswer("accept"),
    });
    const after = await emitSuccess(tool);
    expect(after.isError).toBeUndefined();
    expect(after.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("last pending prompt after accept does not satisfy", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: () => [
          { prompt: artifactPrompt, answer: artifactAnswer("accept") },
          { prompt: artifactPrompt, answer: null },
        ],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("live RunStore reader sees answers appended after the tool is created", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-emit-gate-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "plan-review-proving",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.ensureStageWorkspace(run.runId, "plan-review");
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [gateCheck("artifact_backed")],
        readQaTrail: createAttemptQaTrailReader(
          store,
          run.runId,
          "plan-review",
          1,
        ),
      },
    );
    const before = await emitSuccess(tool);
    expect(before.isError).toBe(true);
    expect(capture).not.toHaveProperty("envelope");

    await appendOperatorPrompt(store, run.runId, "plan-review", artifactPrompt);
    await appendOperatorAnswer(
      store,
      run.runId,
      "plan-review",
      artifactAnswer("accept"),
    );
    const after = await emitSuccess(tool);
    expect(after.isError).toBeUndefined();
    expect(after.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });
});

describe("emit_stage_envelope pre_emit_checks: artifact_declared", () => {
  const explainerHtml =
    "stages/oss-explain-issue/attempts/1/artifacts/issue-explainer.html";

  function explainerOptions(basename: string) {
    return {
      checks: [
        { id: "artifact-present", type: "artifact_declared" as const, basename },
      ],
    };
  }

  it("success with artifacts: [] is rejected when issue-explainer.html is required", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("run-relative explainer path satisfies issue-explainer.html", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: [explainerHtml],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toMatchObject({
      envelope: { artifacts: [explainerHtml] },
    });
  });

  it("exact basename in artifacts satisfies the required name", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: ["issue-explainer.html"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("list containing only notes.md does not satisfy issue-explainer.html", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: ["notes.md"],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("foo-issue-explainer.html does not satisfy issue-explainer.html", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: ["foo-issue-explainer.html"],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("prefixed basename after a directory separator still fails without a slash boundary", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: [
        "stages/oss-explain-issue/attempts/1/artifacts/foo-issue-explainer.html",
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("listed path that is not on disk still succeeds (no filesystem I/O)", async () => {
    const missingPath =
      "stages/oss-explain-issue/attempts/1/artifacts/issue-explainer.html";
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "explained the issue",
      artifacts: [missingPath],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });

  it("omitted checks allows success with artifacts: []", async () => {
    const capture = {};
    const fourArg = createEmitStageEnvelopeTool(capture);
    const fourArgResult = await fourArg.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(fourArgResult.isError).toBeUndefined();
    expect(fourArgResult.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");

    const capture5 = {};
    const fiveArg = createEmitStageEnvelopeTool(
      capture5,
      undefined,
      undefined,
      undefined,
      { checks: [], readQaTrail: () => [] },
    );
    const fiveArgResult = await fiveArg.execute("emit-2", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(fiveArgResult.isError).toBeUndefined();
    expect(fiveArgResult.terminate).toBe(true);
    expect(capture5).toHaveProperty("envelope");
  });

  it("failure emit with empty artifacts succeeds even when artifact_declared is set", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      explainerOptions("issue-explainer.html"),
    );
    const result = await tool.execute("emit-1", {
      status: "failure",
      summary: "could not explain",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toMatchObject({
      envelope: { status: "failure", artifacts: [] },
    });
  });
});

describe("emit_stage_envelope pre_emit_checks: mixed gate + artifact_declared", () => {
  it("declaration order matters for a predictable single error message", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [
          gateCheck("artifact_backed"),
          {
            id: "artifact-present",
            type: "artifact_declared",
            basename: "plan.md",
          },
        ],
        readQaTrail: () => [],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: expect.stringMatching(/artifact_backed/),
    });
    expect(capture).not.toHaveProperty("envelope");
  });

  it("both checks pass: gate accepted and artifact declared", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: [
          gateCheck("artifact_backed"),
          {
            id: "artifact-present",
            type: "artifact_declared",
            basename: "plan.md",
          },
        ],
        readQaTrail: () => [
          { prompt: artifactPrompt, answer: artifactAnswer("accept") },
        ],
      },
    );
    const result = await tool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
  });
});
