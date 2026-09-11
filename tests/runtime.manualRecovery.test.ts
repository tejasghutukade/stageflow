import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRunInput } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { readStageVerificationHistory } from "../src/runstore/verificationHistory.js";
import { RunManager } from "../src/runtime/runManager.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";

async function writeManualRecoveryCatalog(root: string): Promise<string> {
  await writeFile(
    path.join(root, "implement.yaml"),
    [
      "id: implement",
      "system_prompt: Implement the approved work.",
      "model: anthropic/claude-sonnet-4-5",
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
  const pipeline = path.join(root, "manual.pipeline.yaml");
  await writeFile(
    pipeline,
    [
      "id: manual-recovery-demo",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      mode: all",
      "      checks:",
      "        - id: self-review",
      "          type: checklist",
      "          items: [Tests pass]",
      "    recovery:",
      "      mode: manual",
      "      retry_safety: idempotent",
      "      include_failed_checks: true",
      "",
    ].join("\n"),
  );
  return pipeline;
}

async function writeTargetManualRecoveryCatalog(root: string): Promise<string> {
  await writeFile(
    path.join(root, "implement.yaml"),
    [
      "id: implement",
      "system_prompt: Implement the approved work.",
      "model: anthropic/claude-sonnet-4-5",
      "io:",
      "  input:",
      "    schema:",
      "      type: object",
      "  output:",
      "    schema:",
      "      type: object",
      "verify:",
      "  - id: self-review",
      "    type: checklist",
      "    items: [Tests pass]",
      "    when: [after]",
      "",
    ].join("\n"),
  );
  const pipeline = path.join(root, "manual.pipeline.yaml");
  await writeFile(
    pipeline,
    [
      "id: manual-recovery-demo",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    on_verify_fail:",
      "      mode: manual",
      "      retry_safety: idempotent",
      "      include_failed_checks: true",
      "",
    ].join("\n"),
  );
  return pipeline;
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

async function mcpCall(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP response: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
  };
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    status: res.status,
    isError: Boolean(message.result?.isError),
    payload: contentText ? JSON.parse(contentText) : null,
  };
}

async function mcpListTools(base: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP tools/list: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { tools?: Array<{ name: string }> };
  };
  return message.result?.tools ?? [];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

describe("manual completion recovery", () => {
  it("starts only after operator approval and gives the recovery agent guidance plus failed checks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-recover-"));
    const pipeline = await writeManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    expect(initial).toMatchObject({ ok: false, outcome: "failed" });
    await expect(
      store.getLatestStageExecution(initial.runId, "implement"),
    ).resolves.toMatchObject({ verification_outcome: "failed" });

    const inputs: StageRunInput[] = [];
    const base = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const manager = new RunManager({
      agent: {
        openStage(input) {
          inputs.push(input);
          return base.openStage(input);
        },
        runStage(input) {
          return base.runStage(input);
        },
      },
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    await expect(manager.retryStage(initial.runId, "implement")).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Stage uses manual recovery; use the manual recovery action instead of retry",
    });

    await store.updateStageExecution(initial.runId, "implement", 1, {
      verification_outcome: "not_run",
    });
    await expect(
      manager.recoverManualStage(initial.runId, "implement"),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Manual recovery is only available after a completion verification failure",
    });
    await store.updateStageExecution(initial.runId, "implement", 1, {
      verification_outcome: "failed",
    });

    const recovered = await manager.recoverManualStage(
      initial.runId,
      "implement",
      "Run the focused tests and fix the reported failure.",
    );

    expect(recovered).toMatchObject({ ok: true, attemptIndex: 2 });
    if (recovered.ok) {
      await recovered.done;
    }
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.repairContext).toMatchObject({
      prior_attempt: 1,
      operator_guidance: "Run the focused tests and fix the reported failure.",
      failed_checks: [{ id: "self-review", type: "checklist" }],
    });
    await expect(store.readRunMeta(initial.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      store.getLatestStageExecution(initial.runId, "implement"),
    ).resolves.toMatchObject({ verification_outcome: "passed" });
    await expect(
      store.listStageEvents(initial.runId, "implement", 2),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "manual_recovery_requested",
          guidance: "Run the focused tests and fix the reported failure.",
        }),
      ]),
    );
  });

  it("records a stop decision and will not restart the stage in this run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-stop-"));
    const pipeline = await writeManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    await expect(manager.stopManualRecovery(initial.runId, "implement")).resolves.toEqual({
      ok: true,
      runId: initial.runId,
      stageId: "implement",
    });
    await expect(
      readStageVerificationHistory(store, initial.runId, "implement"),
    ).resolves.toMatchObject({
      manual_recovery: { status: "stopped", failed_attempt: 1 },
    });
    await expect(
      manager.recoverManualStage(initial.runId, "implement"),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Manual recovery has been stopped for this stage",
    });
    await expect(manager.retryStage(initial.runId, "implement")).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Stage uses manual recovery; use the manual recovery action instead of retry",
    });
  });

  it("recovers a target-dialect on_verify_fail manual stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-target-"));
    const pipeline = await writeTargetManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    expect(initial).toMatchObject({ ok: false, outcome: "failed" });

    const inputs: StageRunInput[] = [];
    const base = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const manager = new RunManager({
      agent: {
        openStage(input) {
          inputs.push(input);
          return base.openStage(input);
        },
        runStage(input) {
          return base.runStage(input);
        },
      },
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    const recovered = await manager.recoverManualStage(
      initial.runId,
      "implement",
      "Fix the reported failure.",
    );
    expect(recovered).toMatchObject({ ok: true, attemptIndex: 2 });
    if (recovered.ok) {
      await recovered.done;
    }
    expect(inputs[0]?.repairContext).toMatchObject({
      prior_attempt: 1,
      operator_guidance: "Fix the reported failure.",
      failed_checks: [{ id: "self-review", type: "checklist" }],
    });
    await expect(store.readRunMeta(initial.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("resume keeps snapshot after-checks and reloads emit-checks from new-dialect YAML", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-resume-snapshot-"));
    await writeFile(
      path.join(root, "implement.yaml"),
      [
        "id: implement",
        "system_prompt: Implement the approved work.",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: object",
        "clone_input_schema:",
        "  type: object",
        "pre_emit_checks:",
        "  - id: snapshot-emit",
        "    type: artifact_declared",
        "    basename: snapshot-emit.txt",
        "",
      ].join("\n"),
    );
    const pipeline = path.join(root, "manual.pipeline.yaml");
    await writeFile(
      pipeline,
      [
        "id: manual-recovery-demo",
        "stages:",
        "  - id: implement",
        "    uses: ./implement.yaml",
        "    completion:",
        "      mode: all",
        "      checks:",
        "        - id: snap-after",
        "          type: checklist",
        "          items: [Tests pass]",
        "    recovery:",
        "      mode: manual",
        "      retry_safety: idempotent",
        "      include_failed_checks: true",
        "",
      ].join("\n"),
    );
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    expect(initial).toMatchObject({ ok: false, outcome: "failed" });
    const frozen = (await store.readRunMeta(initial.runId)).pipeline_dag;
    expect(frozen?.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "snap-after", type: "checklist", items: ["Tests pass"] }],
    });
    expect(frozen?.nodes[0]?.recovery).toMatchObject({ mode: "manual" });

    await writeFile(
      path.join(root, "implement.yaml"),
      [
        "id: implement",
        "system_prompt: Implement the approved work.",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "verify:",
        "  - id: reloaded-emit",
        "    type: artifact",
        "    basename: reloaded-emit.txt",
        "    when: [emit]",
        "  - id: disk-after",
        "    type: command",
        "    run: \"false\"",
        "    when: [after]",
        "",
      ].join("\n"),
    );
    await writeFile(
      pipeline,
      [
        "id: manual-recovery-demo",
        "stages:",
        "  - id: implement",
        "    uses: ./implement.yaml",
        "    on_verify_fail:",
        "      mode: manual",
        "      retry_safety: idempotent",
        "      include_failed_checks: true",
        "",
      ].join("\n"),
    );

    const inputs: StageRunInput[] = [];
    const base = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "snap-after", items: ["Tests pass"] }],
        },
      },
    ]);
    const manager = new RunManager({
      agent: {
        openStage(input) {
          inputs.push(input);
          return base.openStage(input);
        },
        runStage(input) {
          return base.runStage(input);
        },
      },
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    const recovered = await manager.recoverManualStage(initial.runId, "implement");
    expect(recovered).toMatchObject({ ok: true, attemptIndex: 2 });
    if (recovered.ok) {
      await recovered.done;
    }

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.completionContract).toEqual(frozen?.nodes[0]?.completion);
    expect(inputs[0]?.completionContract?.checks.map((check) => check.id)).toEqual([
      "snap-after",
    ]);
    expect(inputs[0]?.stage.pre_emit_checks).toEqual([
      { id: "reloaded-emit", type: "artifact_declared", basename: "reloaded-emit.txt" },
    ]);
    const afterMeta = await store.readRunMeta(initial.runId);
    expect(afterMeta.pipeline_dag?.nodes[0]?.completion).toEqual(frozen?.nodes[0]?.completion);
    expect(afterMeta.pipeline_dag?.nodes[0]?.recovery).toEqual(frozen?.nodes[0]?.recovery);
    expect(JSON.stringify(afterMeta.pipeline_dag)).not.toContain("disk-after");
    expect(JSON.stringify(afterMeta.pipeline_dag)).not.toContain("on_verify_fail");
    await expect(store.readRunMeta(initial.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("HTTP /recovery and MCP recover_manual_stage still recover a target-dialect stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-http-mcp-"));
    const pipeline = await writeTargetManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    expect(initial).toMatchObject({ ok: false, outcome: "failed" });

    const recoverAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const started = await startUiServer({
      agent: recoverAgent,
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const tools = await mcpListTools(base);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["recover_manual_stage", "stop_manual_recovery"]),
      );

      const recovered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(initial.runId)}/stages/implement/recovery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guidance: "Fix via HTTP recovery." }),
        },
      );
      expect(recovered.status).toBe(202);
      expect(recovered.body).toMatchObject({
        runId: initial.runId,
        stageId: "implement",
        attemptIndex: 2,
      });
      await waitFor(async () => (await store.readRunMeta(initial.runId)).status === "succeeded");
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const stopRoot = await mkdtemp(path.join(tmpdir(), "sf-manual-mcp-stop-"));
    const stopPipeline = await writeTargetManualRecoveryCatalog(stopRoot);
    const stopStore = createRunStore({ rootDir: stopRoot });
    const parked = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store: stopStore,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: stopPipeline,
      cwd: stopRoot,
      executionMode: "inprocess",
    });
    const mcpAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const mcpStarted = await startUiServer({
      agent: mcpAgent,
      cwd: stopRoot,
      rootDir: stopRoot,
      store: stopStore,
      port: 0,
      uiDistDir: path.join(stopRoot, "missing-ui"),
      mcpStateless: true,
    });
    const mcpAddress = mcpStarted.server.address();
    if (!mcpAddress || typeof mcpAddress === "string") {
      throw new Error("expected TCP address");
    }
    const mcpBase = `http://127.0.0.1:${mcpAddress.port}`;
    try {
      const recovered = await mcpCall(mcpBase, "recover_manual_stage", {
        runId: parked.runId,
        stageId: "implement",
        guidance: "Fix via MCP recover_manual_stage.",
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.payload).toMatchObject({
        runId: parked.runId,
        stageId: "implement",
        attemptIndex: 2,
      });
      await waitFor(
        async () => (await stopStore.readRunMeta(parked.runId)).status === "succeeded",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        mcpStarted.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
