import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
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

async function emitSuccess(tool: ReturnType<typeof createEmitStageEnvelopeTool>) {
  return tool.execute("emit-1", approvedSuccess);
}

const explainerHtml = "stages/oss-explain-issue/attempts/1/artifacts/issue-explainer.html";

type EmitOptions = NonNullable<Parameters<typeof createEmitStageEnvelopeTool>[4]>;

async function emit(
  options: EmitOptions | undefined,
  envelope: Record<string, unknown> = approvedSuccess,
  payloadSchema?: Record<string, unknown>,
) {
  const capture = {};
  const tool = createEmitStageEnvelopeTool(
    capture,
    payloadSchema,
    undefined,
    undefined,
    options,
  );
  const result = await tool.execute("emit-1", envelope);
  return { result, capture };
}

function expectAccepted({ result, capture }: Awaited<ReturnType<typeof emit>>) {
  expect(result.isError).toBeUndefined();
  expect(result.terminate).toBe(true);
  expect(capture).toHaveProperty("envelope");
}

function expectRejected({ result, capture }: Awaited<ReturnType<typeof emit>>) {
  expect(result.isError).toBe(true);
  expect(result.terminate).toBeUndefined();
  expect(capture).not.toHaveProperty("envelope");
}

const plainSuccess = { status: "success", summary: "ok", artifacts: [] };

describe("emit_stage_envelope payload_schema", () => {
  const schema = {
    type: "object",
    required: ["changed_files"],
    properties: {
      changed_files: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  };

  it("accepts a matching payload, rejects a bad one, and skips the schema on failure", async () => {
    expectAccepted(
      await emit(undefined, { ...plainSuccess, payload: { changed_files: ["a.ts"] } }, schema),
    );
    expectRejected(
      await emit(undefined, { ...plainSuccess, payload: { changed_files: [] } }, schema),
    );

    const failure = await emit(
      undefined,
      { status: "failure", summary: "blocked", artifacts: [] },
      schema,
    );
    expectAccepted(failure);
    expect(failure.capture).toMatchObject({ envelope: { status: "failure" } });
  });

  it("accepts an untyped payload when the stage declares no payload_schema", async () => {
    const out = await emit(undefined, { ...plainSuccess, payload: { anything: true } });
    expectAccepted(out);
    expect(out.capture).toMatchObject({ envelope: { payload: { anything: true } } });
  });
});

describe("emit_stage_envelope pre_emit_checks: gate", () => {
  const ftChecks = (kind: StageGateKind) => ({ checks: [gateCheck(kind)] });

  it.each([
    {
      name: "artifact_backed with zero QA events is rejected",
      kind: "artifact_backed" as const,
      trail: [] as QaExchange[],
      ok: false,
    },
    {
      name: "last artifact_backed decision reject is rejected",
      kind: "artifact_backed" as const,
      trail: [{ prompt: artifactPrompt, answer: artifactAnswer("reject") }],
      ok: false,
    },
    {
      name: "reject then accept is accepted",
      kind: "artifact_backed" as const,
      trail: [
        { prompt: artifactPrompt, answer: artifactAnswer("reject") },
        { prompt: artifactPrompt, answer: artifactAnswer("accept") },
      ],
      ok: true,
    },
    {
      name: "last pending prompt after accept does not satisfy",
      kind: "artifact_backed" as const,
      trail: [
        { prompt: artifactPrompt, answer: artifactAnswer("accept") },
        { prompt: artifactPrompt, answer: null },
      ],
      ok: false,
    },
    {
      name: "confirm accept then reject: only the last decision matters (rejected)",
      kind: "confirm" as const,
      trail: [
        { prompt: confirmPrompt("c1"), answer: confirmAnswer("c1", "accept") },
        { prompt: confirmPrompt("c2"), answer: confirmAnswer("c2", "reject") },
      ],
      ok: false,
    },
    {
      name: "confirm reject then accept: only the last decision matters (accepted)",
      kind: "confirm" as const,
      trail: [
        { prompt: confirmPrompt("c1"), answer: confirmAnswer("c1", "reject") },
        { prompt: confirmPrompt("c2"), answer: confirmAnswer("c2", "accept") },
      ],
      ok: true,
    },
    {
      name: "free_text: any completed answer satisfies without decision",
      kind: "free_text" as const,
      trail: [freeTextExchange(true)],
      ok: true,
    },
    {
      name: "free_text: pending-only does not satisfy",
      kind: "free_text" as const,
      trail: [freeTextExchange(false)],
      ok: false,
    },
    {
      name: "multi_question: any completed answer satisfies",
      kind: "multi_question" as const,
      trail: [multiQuestionExchange()],
      ok: true,
    },
  ])("$name", async ({ kind, trail, ok }) => {
    const out = await emit({ ...ftChecks(kind), readQaTrail: () => trail }, plainSuccess);
    if (ok) expectAccepted(out);
    else expectRejected(out);
  });

  it("omitted pre_emit_checks may emit success with no QA events", async () => {
    expectAccepted(await emit(undefined));
  });

  it("empty checks list skips completion even when a reader is present", async () => {
    expectAccepted(await emit({ checks: [], readQaTrail: () => [] }));
  });

  it("failure envelopes skip the declared-gate check", async () => {
    const out = await emit(
      { ...ftChecks("artifact_backed"), readQaTrail: () => [] },
      { status: "failure", summary: "blocked", artifacts: [] },
    );
    expectAccepted(out);
    expect(out.capture).toMatchObject({ envelope: { status: "failure" } });
  });

  it("gate check without a reader fails closed on success", async () => {
    expectRejected(await emit(ftChecks("artifact_backed")));
  });

  it("reads the trail inside execute, not at factory time", async () => {
    const exchanges: QaExchange[] = [];
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture, undefined, undefined, undefined, {
      checks: [gateCheck("artifact_backed")],
      readQaTrail: () => exchanges,
    });
    const before = await emitSuccess(tool);
    expect(before.isError).toBe(true);
    expect(capture).not.toHaveProperty("envelope");

    exchanges.push({ prompt: artifactPrompt, answer: artifactAnswer("accept") });
    const after = await emitSuccess(tool);
    expect(after.isError).toBeUndefined();
    expect(after.terminate).toBe(true);
    expect(capture).toHaveProperty("envelope");
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
  const explainerOptions = (basename: string) => ({
    checks: [{ id: "artifact-present", type: "artifact_declared" as const, basename }],
  });
  const explained = (artifacts: string[], status = "success") => ({
    status,
    summary: "explained the issue",
    artifacts,
  });

  it.each([
    { name: "artifacts: [] is rejected", artifacts: [] as string[], ok: false },
    { name: "run-relative explainer path satisfies the name", artifacts: [explainerHtml], ok: true },
    { name: "exact basename satisfies the name", artifacts: ["issue-explainer.html"], ok: true },
    { name: "only notes.md does not satisfy", artifacts: ["notes.md"], ok: false },
    { name: "foo-issue-explainer.html does not satisfy", artifacts: ["foo-issue-explainer.html"], ok: false },
    {
      name: "prefixed basename after a directory separator fails without a slash boundary",
      artifacts: ["stages/oss-explain-issue/attempts/1/artifacts/foo-issue-explainer.html"],
      ok: false,
    },
  ])("issue-explainer.html required: $name", async ({ artifacts, ok }) => {
    const out = await emit(explainerOptions("issue-explainer.html"), explained(artifacts));
    if (ok) {
      expectAccepted(out);
      expect(out.capture).toMatchObject({ envelope: { artifacts } });
    } else {
      expectRejected(out);
    }
  });

  it("failure emit with empty artifacts succeeds even when artifact_declared is set", async () => {
    const out = await emit(explainerOptions("issue-explainer.html"), explained([], "failure"));
    expectAccepted(out);
    expect(out.capture).toMatchObject({ envelope: { status: "failure", artifacts: [] } });
  });
});

describe("emit_stage_envelope pre_emit_checks: mixed gate + artifact_declared", () => {
  const mixedChecks = [
    gateCheck("artifact_backed"),
    { id: "artifact-present", type: "artifact_declared" as const, basename: "plan.md" },
  ];

  it("declaration order matters for a predictable single error message", async () => {
    const out = await emit({ checks: mixedChecks, readQaTrail: () => [] }, plainSuccess);
    expectRejected(out);
    expect(out.result.details).toMatchObject({
      error: expect.stringMatching(/artifact_backed/),
    });
  });

  it("artifact_declared still rejects when the gate passes but the artifact is missing", async () => {
    const out = await emit(
      {
        checks: mixedChecks,
        readQaTrail: () => [{ prompt: artifactPrompt, answer: artifactAnswer("accept") }],
      },
      plainSuccess,
    );
    expectRejected(out);
    expect(out.result.details).toMatchObject({
      error: expect.stringMatching(/plan\.md/),
    });
  });

  it("both checks pass: gate accepted and artifact declared", async () => {
    expectAccepted(
      await emit(
        {
          checks: mixedChecks,
          readQaTrail: () => [{ prompt: artifactPrompt, answer: artifactAnswer("accept") }],
        },
        { ...plainSuccess, artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"] },
      ),
    );
  });
});

describe("emit_stage_envelope verify when: [emit]", () => {
  it("gate failure is isError and does not terminate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verify-emit-"));
    await writeFile(
      path.join(root, "demo.pipeline.yaml"),
      [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "    gate_kinds: [confirm]",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "        when: [emit]",
        "",
      ].join("\n"),
    );
    const loaded = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      {
        checks: loaded.value.stages[0]?.pre_emit_checks,
        readQaTrail: () => [],
      },
    );
    const result = await emitSuccess(tool);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture).not.toHaveProperty("envelope");
  });

  it("lists envelope basename for type: artifact when emit without requiring the file on disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verify-emit-artifact-"));
    await writeFile(
      path.join(root, "demo.pipeline.yaml"),
      [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        basename: report.md",
        "        when: [emit, after]",
        "",
      ].join("\n"),
    );
    const loaded = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const missing = {};
    const missingTool = createEmitStageEnvelopeTool(
      missing,
      undefined,
      undefined,
      undefined,
      { checks: loaded.value.stages[0]?.pre_emit_checks },
    );
    const missingResult = await missingTool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(missingResult.isError).toBe(true);
    expect(missingResult.terminate).toBeUndefined();

    const listed = {};
    const listedTool = createEmitStageEnvelopeTool(
      listed,
      undefined,
      undefined,
      undefined,
      { checks: loaded.value.stages[0]?.pre_emit_checks },
    );
    const listedResult = await listedTool.execute("emit-1", {
      status: "success",
      summary: "ok",
      artifacts: ["stages/plan/attempts/1/artifacts/report.md"],
    });
    expect(listedResult.isError).toBeUndefined();
    expect(listedResult.terminate).toBe(true);
    expect(listed).toHaveProperty("envelope");
  });
});
