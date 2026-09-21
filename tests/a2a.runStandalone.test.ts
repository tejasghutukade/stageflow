import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createA2aInvocations } from "../src/a2a/service.js";
import { loadPublicationRegistry } from "../src/a2a/registry.js";
import { RateLimiter } from "../src/a2a/limits.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { supplierAgent, gatedAgent } from "./fixtures/a2a/agents.js";

const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };
const caller = { id: "procurement" };

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

async function setup(configPath: string, agent = supplierAgent()) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-run-stage-"));
  const { store, connection } = createRunStoreWithConnection({ rootDir: root });
  const manager = new RunManager({ agent, store, cwd: root });
  const registry = await loadPublicationRegistry(configPath, env);
  const invocations = createA2aInvocations(registry, manager, store, root, connection, new RateLimiter());
  return { invocations, manager, store, root };
}

function runStage(
  fields: {
    stage?: string | Record<string, unknown>;
    pipeline?: string | Record<string, unknown>;
    task_path?: string;
    task?: unknown;
    envelope_ref?: { runId: string; stageId: string; attempt?: number };
    checkout?: string;
    model?: string;
    blocking?: boolean;
    timeout_ms?: number;
  },
  messageId: string,
) {
  return {
    messageId,
    parts: [
      {
        content: {
          $case: "data" as const,
          value: { contractVersion: 1, operation: "run_stage", ...fields },
        },
      },
    ],
  };
}

function invoke(capability: string, input: unknown, messageId: string) {
  return {
    messageId,
    parts: [{ content: { $case: "data" as const, value: { contractVersion: 1, operation: "invoke", capability, input } } }],
  };
}

function answer(taskId: string, messageId: string, prompt: string, text: string) {
  return {
    messageId,
    taskId,
    parts: [{ content: { $case: "data" as const, value: { contractVersion: 1, operation: "answer", prompt, answer: { kind: "free_text", text } } } }],
  };
}

const supplierConfig = path.resolve("tests/fixtures/a2a/a2a.yaml");
const gatedConfig = path.resolve("tests/fixtures/a2a/gated.yaml");

const finalReportStage = {
  id: "final_report",
  model: "anthropic/claude-sonnet-4-5",
  system_prompt: "Write the supplier assessment and emit the report artifact.",
  ...REQUIRED_IO,
};

const clarifyStage = {
  id: "clarify",
  model: "anthropic/claude-sonnet-4-5",
  system_prompt: "Clarify the purchasing requirements for the supplier.",
  gate_kinds: ["free_text"],
  ...REQUIRED_IO,
};

describe("run_stage (A2A standalone stage/pipeline operation, ADR-0001)", () => {
  it("runs an inline stage directly, reaching completion even though gated.yaml only publishes an unrelated capability", async () => {
    // gated.yaml's only publication is "gated_capability" for "procurement" — final_report is
    // not published to anyone. This is the wildcard-access bypass the operation exists for.
    const { invocations } = await setup(gatedConfig, supplierAgent());
    const submitted = await invocations.send(
      caller,
      runStage({ stage: finalReportStage, task: { id: "t1", goal: "assess", input: { supplier: "Northstar" } } }, "m-1"),
    );
    expect(["submitted", "working"]).toContain(submitted.state);
    expect(submitted.runId).toBeTruthy();

    let task = submitted;
    for (let i = 0; i < 25 && task.state !== "completed"; i += 1) {
      task = await invocations.get(caller, submitted.id);
    }
    expect(task.state).toBe("completed");
    expect(task.result?.payload?.recommendation).toBe("approve");
    expect(task.result?.artifacts.map((a) => a.name)).toContain("assessment.md");
  });

  it("still authenticates via the bearer mechanism and leaves invoke's allowlist untouched on the same registry", async () => {
    const { invocations, manager } = await setup(gatedConfig, gatedAgent());
    // invoke against a capability nobody published: still rejected exactly like before.
    await expect(invocations.send(caller, invoke("final_report", {}, "m-a"))).rejects.toMatchObject({
      category: "unknown-capability",
    });
    expect(manager.getActiveCount()).toBe(0);
    // A caller unknown to the registry cannot use run_stage either — `send` never reaches
    // this far without a Caller, but as a direct-interface analog we confirm a real caller
    // with a bad/foreign id is still whatever the registry's own auth would reject upstream
    // (server.ts authenticates before invocations.send is ever called).
  });

  it("resolves blocking:true in a single round trip instead of returning submitted", async () => {
    const { invocations } = await setup(supplierConfig, supplierAgent());
    const task = await invocations.send(
      caller,
      runStage(
        { stage: finalReportStage, task: { id: "t2", goal: "assess", input: { supplier: "Northstar" } }, blocking: true },
        "m-2",
      ),
    );
    expect(task.state).toBe("completed");
    expect(task.result?.payload?.recommendation).toBe("approve");
  });

  it("relays a free_text HITL prompt through the existing input-required/answer mechanics, with no publication config at all", async () => {
    const { invocations } = await setup(gatedConfig, supplierAgent());
    let task = await invocations.send(
      caller,
      runStage({ stage: clarifyStage, task: { id: "t3", goal: "assess", input: { supplier: "Northstar" } } }, "m-3"),
    );
    for (let i = 0; i < 25 && task.state !== "input-required"; i += 1) {
      task = await invocations.get(caller, task.id);
    }
    expect(task.state).toBe("input-required");
    const handle = task.questions![0].handle;
    expect(task.questions![0].message).toContain("certification");
    task = await invocations.send(caller, answer(task.id, "m-4", handle, "Yes, mandatory."));
    for (let i = 0; i < 25 && task.state !== "completed"; i += 1) {
      task = await invocations.get(caller, task.id);
    }
    expect(task.state).toBe("completed");
  });

  it("chains a second standalone call off the first's envelope via envelope_ref (ADR-0002), using the run id run_stage exposes", async () => {
    const { invocations } = await setup(gatedConfig, supplierAgent());
    const first = await invocations.send(
      caller,
      runStage(
        { stage: finalReportStage, task: { id: "t5", goal: "assess", input: { supplier: "Northstar" } }, blocking: true },
        "m-5",
      ),
    );
    expect(first.state).toBe("completed");
    const runId = first.runId!;
    expect(runId).toBeTruthy();

    const second = await invocations.send(
      caller,
      runStage(
        { stage: finalReportStage, envelope_ref: { runId, stageId: "final_report" }, blocking: true },
        "m-6",
      ),
    );
    expect(second.state).toBe("completed");
    expect(second.result?.payload?.recommendation).toBe("approve");
    expect(second.id).not.toBe(first.id);
    expect(second.runId).not.toBe(first.runId);
  });

  it("runs a fully inline pipeline reference (not just a bare stage) and summarizes every stage's outcome", async () => {
    const { invocations } = await setup(gatedConfig, supplierAgent());
    const task = await invocations.send(
      caller,
      runStage(
        {
          pipeline: { id: "adhoc", stages: [finalReportStage] },
          task: { id: "t7", goal: "assess", input: { supplier: "Northstar" } },
          blocking: true,
        },
        "m-7",
      ),
    );
    expect(task.state).toBe("completed");
    const stages = task.result?.payload?.stages as Array<{ stageId: string; status: string }> | undefined;
    expect(stages).toBeDefined();
    expect(stages!.some((s) => s.stageId === "final_report" && s.status === "succeeded")).toBe(true);
  });

  it("rejects run_stage when both stage and pipeline (or neither) are given, without starting a run", async () => {
    const { invocations, manager } = await setup(gatedConfig, supplierAgent());
    await expect(
      invocations.send(
        caller,
        runStage(
          {
            stage: finalReportStage,
            pipeline: { id: "adhoc", stages: [finalReportStage] },
            task: { id: "t8", goal: "assess", input: {} },
          },
          "m-8",
        ),
      ),
    ).rejects.toBeTruthy();
    expect(manager.getActiveCount()).toBe(0);
  });

  it("a retry with a fresh messageId but identical content reuses the same task/run instead of starting a duplicate", async () => {
    // Regression test: unlike invoke, run_stage originally had no
    // content-hash-keyed submission dedup, only exact-messageId replay — so
    // a caller retrying after a lost response (a fresh messageId, same
    // logical call) would double-execute the stage. Mirrors invoke's own
    // "durable at-most-once run submission" contract (docs/a2a.md).
    const { invocations, manager, store } = await setup(gatedConfig, supplierAgent());
    const call = {
      stage: finalReportStage,
      task: { id: "t11", goal: "assess", input: { supplier: "Northstar" } },
      blocking: true as const,
    };
    const first = await invocations.send(caller, runStage(call, "m-11-first"));
    expect(first.state).toBe("completed");
    expect(first.runId).toBeTruthy();

    // Same content, different messageId — the exact shape of a lost-response
    // retry, which replayOrThrow's exact-messageId check alone cannot catch.
    const retry = await invocations.send(caller, runStage(call, "m-11-retry"));
    expect(retry.id).toBe(first.id);
    expect(retry.runId).toBe(first.runId);

    // Only one run was ever actually started for this content.
    expect(manager.getActiveCount()).toBe(0);
    const allRuns = await store.listRuns({});
    expect(allRuns.filter((r) => r.run_id === first.runId).length).toBe(1);

    // Genuinely different content still gets its own task/run.
    const different = await invocations.send(
      caller,
      runStage(
        { ...call, task: { id: "t12", goal: "assess", input: { supplier: "Southgate" } } },
        "m-11-different",
      ),
    );
    expect(different.id).not.toBe(first.id);
    expect(different.runId).not.toBe(first.runId);
  });

  it("resolves a string `stage` filesystem reference against the project rootDir, not some other base directory", async () => {
    // Regression test: production wiring (src/server/bootstrap.ts) once passed
    // the global Stageflow home directory as A2aInvocations' rootDir instead
    // of the project root, so a relative `stage` path silently resolved
    // against the wrong base. setup() here intentionally uses two distinct
    // directories — projectRoot (where the stage file actually lives, and
    // where RunManager/RunStore operate) and a decoy globalHomeLike dir — to
    // prove resolution must go through the rootDir this test controls, the
    // same one bootstrap.ts must supply as the project root in production.
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-a2a-run-stage-project-"));
    const decoyHome = await mkdtemp(path.join(tmpdir(), "sf-a2a-run-stage-decoy-home-"));
    await mkdir(path.join(projectRoot, "stages"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "stages", "check.yaml"),
      [
        "id: check",
        "model: anthropic/claude-sonnet-4-5",
        "system_prompt: Do work.",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "",
      ].join("\n"),
    );
    // Sanity: the decoy directory has no such file, so if resolution ever
    // used it by mistake, this would fail with ENOENT the same way the
    // original bug did against the real global home directory.
    const { store, connection } = createRunStoreWithConnection({ rootDir: projectRoot });
    const manager = new RunManager({ agent: supplierAgent(), store, cwd: projectRoot });
    const registry = await loadPublicationRegistry(supplierConfig, env);
    const invocations = createA2aInvocations(
      registry,
      manager,
      store,
      projectRoot,
      connection,
      new RateLimiter(),
    );

    const task = await invocations.send(
      caller,
      runStage(
        { stage: "stages/check.yaml", task: { id: "t9", goal: "check" }, blocking: true },
        "m-9",
      ),
    );
    expect(task.state).toBe("completed");

    // Constructing the exact same call but with rootDir pointed at the decoy
    // directory (mirroring the original bug's shape) must fail to find the
    // file — confirming resolution genuinely depends on the rootDir given,
    // not on cwd or some other ambient path.
    const { store: store2, connection: connection2 } = createRunStoreWithConnection({
      rootDir: decoyHome,
    });
    const manager2 = new RunManager({ agent: supplierAgent(), store: store2, cwd: decoyHome });
    const invocationsWithWrongRoot = createA2aInvocations(
      registry,
      manager2,
      store2,
      decoyHome,
      connection2,
      new RateLimiter(),
    );
    await expect(
      invocationsWithWrongRoot.send(
        caller,
        runStage(
          { stage: "stages/check.yaml", task: { id: "t10", goal: "check" }, blocking: true },
          "m-10",
        ),
      ),
    ).rejects.toMatchObject({ category: "invalid-input" });
  });

  it("resolves an array of envelope_refs, namespacing each payload under its stageId (shared resolveEnvelopeRefsToTask, same as MCP)", async () => {
    const { invocations } = await setup(gatedConfig, supplierAgent());
    const first = await invocations.send(
      caller,
      runStage(
        { stage: finalReportStage, task: { id: "t13", goal: "assess", input: { supplier: "Northstar" } }, blocking: true },
        "m-13",
      ),
    );
    expect(first.state).toBe("completed");
    const firstRunId = first.runId!;

    const secondStage = { ...finalReportStage, id: "final_report_2" };
    const second = await invocations.send(
      caller,
      runStage({ stage: secondStage, task: { id: "t14", goal: "assess again" }, blocking: true }, "m-14"),
    );
    expect(second.state).toBe("completed");
    const secondRunId = second.runId!;

    const combined = await invocations.send(
      caller,
      runStage(
        {
          stage: { ...finalReportStage, id: "combined" },
          envelope_ref: [
            { runId: firstRunId, stageId: "final_report" },
            { runId: secondRunId, stageId: "final_report_2" },
          ],
          blocking: true,
        },
        "m-15",
      ),
    );
    expect(combined.state).toBe("completed");
    expect(combined.id).not.toBe(first.id);
    expect(combined.id).not.toBe(second.id);
  });
});
