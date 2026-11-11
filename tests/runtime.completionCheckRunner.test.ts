import { mkdir, symlink, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { StageRunInput } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import {
  nodeCommandExecutor,
  runCompletionContract,
  type CheckoutCapability,
  type CommandExecutor,
  type CompletionCheckRunnerInput,
  type GateDecisionProvider,
} from "../src/runtime/completionCheckRunner.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { CompletionContract } from "../src/types/completion.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const before = { entries: [{ path: "src/app.ts", fingerprint: "before" }] };

function envelope(payload?: Record<string, unknown>): StageEnvelope {
  return {
    status: "success",
    summary: "finished",
    artifacts: [],
    ...(payload !== undefined ? { payload } : {}),
  };
}

function fakeCommand(result: {
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
  error?: string;
}): CommandExecutor & { calls: Array<{ command: string; cwd: string; timeout_ms?: number }> } {
  const calls: Array<{ command: string; cwd: string; timeout_ms?: number }> = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return {
        exit_code: result.exit_code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timed_out: result.timed_out ?? false,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
  };
}

function fakeCheckout(changes: Awaited<ReturnType<CheckoutCapability["changesSince"]>>): CheckoutCapability {
  return {
    async capture() {
      return before;
    },
    async changesSince(snapshot) {
      expect(snapshot).toEqual(before);
      return changes;
    },
  };
}

function fakeGates(decisions: Awaited<ReturnType<GateDecisionProvider["listDecisions"]>>): GateDecisionProvider {
  return {
    async listDecisions() {
      return decisions;
    },
  };
}

const completeContract: CompletionContract = {
  mode: "all",
  checks: [
    { id: "tests", type: "command", run: "npm test", cwd: "project", timeout_ms: 1000 },
    { id: "report", type: "artifact", path: "implementation-report.md", nonempty: true },
    { id: "handoff", type: "payload_schema" },
    { id: "approval", type: "gate", kind: "confirm" },
    { id: "changes", type: "checkout_changes", path_fields: ["changed_files"] },
    { id: "self-review", type: "checklist", items: ["Tests pass", "No unrelated changes"] },
  ],
};

describe("runCompletionContract", () => {
  it("runs every supported check and records normalized evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-completion-runner-"));
    const artifactsDir = path.join(root, "artifacts");
    await mkdir(artifactsDir);
    await writeFile(path.join(artifactsDir, "implementation-report.md"), "Implemented safely.\n");
    const command = fakeCommand({ exit_code: 0, stdout: "all green\n" });

    const outcome = await runCompletionContract({
      contract: completeContract,
      envelope: envelope({ changed_files: ["src/app.ts"] }),
      payloadSchema: {
        type: "object",
        properties: {
          changed_files: { type: "array", items: { type: "string" } },
        },
        required: ["changed_files"],
      },
      artifactsDir,
      commandWorkingDirectory: root,
      commandExecutor: command,
      gates: fakeGates([{ kind: "confirm", status: "accepted", prompt_id: "z" }]),
      checkoutBefore: before,
      checkout: fakeCheckout([{ path: "src/app.ts", status: "modified" }]),
      checklistAttestations: [
        { check_id: "self-review", items: ["No unrelated changes", "Tests pass"] },
      ],
    });

    expect(outcome).toMatchObject({ outcome: "passed", failed_check_ids: [] });
    expect(outcome.checks.map((check) => check.outcome)).toEqual([
      "passed", "passed", "passed", "passed", "passed", "passed",
    ]);
    expect(command.calls).toEqual([
      { command: "npm test", cwd: path.join(root, "project"), timeout_ms: 1000 },
    ]);
    expect(outcome.checks[0]?.evidence).toMatchObject({
      kind: "command", exit_code: 0, stdout: "all green\n",
    });
    expect(outcome.checks[1]?.evidence).toMatchObject({
      kind: "artifact", exists: true, file_type: "file", size_bytes: 20,
    });
    expect(outcome.checks[1]?.evidence).toHaveProperty("sha256");
    expect(outcome.checks[4]?.evidence).toMatchObject({
      kind: "checkout_changes",
      claimed_paths: ["src/app.ts"],
      changes: [{ path: "src/app.ts", status: "modified" }],
    });
    expect(outcome.checks[5]?.evidence).toMatchObject({
      kind: "checklist",
      expected_items: ["No unrelated changes", "Tests pass"],
      missing_items: [],
      unexpected_items: [],
    });
  });

  it("runs later checks after failures so repair receives every failure", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "sf-completion-fail-"));
    const command = fakeCommand({ exit_code: 1, stderr: "test failed" });

    const outcome = await runCompletionContract({
      contract: completeContract,
      envelope: envelope({ changed_files: ["src/claimed.ts"] }),
      payloadSchema: {
        type: "object",
        properties: { changed_files: { type: "string" } },
        required: ["changed_files"],
      },
      artifactsDir,
      commandWorkingDirectory: artifactsDir,
      commandExecutor: command,
      gates: fakeGates([{ kind: "confirm", status: "rejected", prompt_id: "a" }]),
      checkoutBefore: before,
      checkout: fakeCheckout([{ path: "src/actual.ts", status: "modified" }]),
      checklistAttestations: [{ check_id: "self-review", items: ["Tests pass"] }],
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      failed_check_ids: ["tests", "report", "handoff", "approval", "changes", "self-review"],
    });
    expect(command.calls).toHaveLength(1);
    expect(outcome.checks[0]).toMatchObject({ outcome: "failed", message: "command exited with code 1" });
    expect(outcome.checks[1]).toMatchObject({ outcome: "failed", message: "artifact is missing" });
    expect(outcome.checks[2]).toMatchObject({ outcome: "failed" });
    expect(outcome.checks[3]).toMatchObject({ outcome: "failed", message: "no accepted confirm gate decision" });
    expect(outcome.checks[4]?.evidence).toMatchObject({
      missing_claimed_paths: ["src/claimed.ts"],
      unclaimed_changed_paths: ["src/actual.ts"],
    });
    expect(outcome.checks[5]?.evidence).toMatchObject({
      missing_items: ["No unrelated changes"],
    });
  });

  it("after-phase artifact with nonempty fails on an empty file", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "sf-completion-empty-"));
    await writeFile(path.join(artifactsDir, "report.md"), "");
    const outcome = await runCompletionContract({
      contract: {
        mode: "all",
        checks: [{ id: "report", type: "artifact", path: "report.md", nonempty: true }],
      },
      envelope: envelope(),
      artifactsDir,
    });
    expect(outcome).toMatchObject({
      outcome: "failed",
      failed_check_ids: ["report"],
    });
    expect(outcome.checks[0]).toMatchObject({
      outcome: "failed",
      message: "artifact is empty",
    });
  });

  it("rejects symlink artifacts, including symlinked parent directories, and reports missing runtime capabilities as errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-completion-links-"));
    const artifactsDir = path.join(root, "artifacts");
    await mkdir(artifactsDir);
    await writeFile(path.join(root, "outside.txt"), "outside");
    await symlink(path.join(root, "outside.txt"), path.join(artifactsDir, "report.md"));

    const outcome = await runCompletionContract({
      contract: {
        mode: "all",
        checks: [
          { id: "report", type: "artifact", path: "report.md" },
          { id: "command", type: "command", run: "true" },
          { id: "gate", type: "gate", kind: "confirm" },
          { id: "checkout", type: "checkout_changes" },
        ],
      },
      envelope: envelope(),
      artifactsDir,
    });

    expect(outcome.checks.map((check) => check.outcome)).toEqual(["failed", "error", "error", "error"]);
    expect(outcome.checks[0]?.evidence).toMatchObject({ file_type: "symlink" });

    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "outside", "nested.md"), "outside");
    await symlink(path.join(root, "outside"), path.join(artifactsDir, "linked"));
    const nested = await runCompletionContract({
      contract: { mode: "all", checks: [{ id: "nested", type: "artifact", path: "linked/nested.md" }] },
      envelope: envelope(),
      artifactsDir,
    });
    expect(nested.checks[0]?.evidence).toMatchObject({ file_type: "symlink" });
  });
});

const FUNCTION_FIXTURE = path.resolve("tests/fixtures/pipelines/function-verify.pipeline.yaml");

function functionContract(ids: string[]): CompletionContract {
  return {
    mode: "all",
    checks: ids.map((id) => ({ id, type: "function" as const, function: "score", grants: [] })),
  };
}

function functionRunnerInput(
  contract: CompletionContract,
  functions: CompletionCheckRunnerInput["functions"],
  revision: (functionId: string) => number | undefined = () => 1,
): CompletionCheckRunnerInput {
  return {
    contract,
    envelope: envelope(),
    artifactsDir: "/tmp/unused",
    functions,
    functionRevision: revision,
  };
}

describe("function verification checks", () => {
  it("records passed false, a thrown error, and an extra field as distinct rows", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "sf-fn-rows-"));
    const seen: string[] = [];
    const responses = [
      { ok: true, value: { passed: false, message: "low", details: { score: 1 } }, revision: 1 },
      { ok: false, code: "exception", message: "Error: boom", revision: 1 },
      { ok: false, code: "timeout", message: "function timed out", revision: 1 },
      { ok: true, value: { passed: true, extra: 1 }, revision: 1 },
    ];
    const outcome = await runCompletionContract({
      ...functionRunnerInput(functionContract(["low", "boom", "slow", "extra"]), {
        async invoke(request) {
          seen.push(request.checkId);
          const next = responses[seen.length - 1];
          if (!next) throw new Error("unexpected function check");
          return next;
        },
      }),
      artifactsDir,
    });
    expect(seen).toEqual(["low", "boom", "slow", "extra"]);
    expect(outcome.checks.map((check) => check.outcome)).toEqual(["failed", "error", "error", "error"]);
    expect(outcome.checks[0]).toMatchObject({
      outcome: "failed",
      message: "low",
      evidence: { kind: "function", function_id: "score", revision: 1, passed: false, details: { score: 1 } },
    });
    expect(outcome.checks[0]?.evidence).not.toHaveProperty("code");
    expect(outcome.checks[1]).toMatchObject({
      outcome: "error",
      evidence: { kind: "function", code: "exception", revision: 1 },
    });
    expect(outcome.checks[2]).toMatchObject({
      outcome: "error",
      evidence: { kind: "function", code: "timeout", revision: 1 },
    });
    expect(outcome.checks[3]).toMatchObject({
      outcome: "error",
      message: expect.stringMatching(/extra/),
      evidence: { kind: "function", code: "invalid_output", revision: 1 },
    });
  });

  it("collects both failing after-phase function checks", async () => {
    const calls: string[] = [];
    const outcome = await runCompletionContract(
      functionRunnerInput(functionContract(["first", "second"]), {
        async invoke(request) {
          calls.push(`${request.checkId}:${request.revision}`);
          return {
            ok: true,
            value: { passed: false, message: request.checkId },
            revision: request.revision,
          };
        },
      }, () => 7),
    );
    expect(calls).toEqual(["first:7", "second:7"]);
    expect(outcome.failed_check_ids).toEqual(["first", "second"]);
    expect(outcome.checks.map((check) => check.message)).toEqual(["first", "second"]);
  });

  it("does not call the function invoker when the contract has no function field", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "sf-fn-absent-"));
    await writeFile(path.join(artifactsDir, "implementation-report.md"), "Implemented safely.\n");
    let calls = 0;
    const outcome = await runCompletionContract({
      ...functionRunnerInput(completeContract, {
        async invoke() {
          calls += 1;
          return { ok: false, code: "exception", message: "should not run", revision: null };
        },
      }),
      artifactsDir,
      commandWorkingDirectory: artifactsDir,
      commandExecutor: fakeCommand({ exit_code: 0, stdout: "all green\n" }),
      gates: fakeGates([{ kind: "confirm", status: "accepted", prompt_id: "z" }]),
      checkoutBefore: before,
      checkout: fakeCheckout([{ path: "src/app.ts", status: "modified" }]),
      checklistAttestations: [
        { check_id: "self-review", items: ["No unrelated changes", "Tests pass"] },
      ],
      envelope: envelope({ changed_files: ["src/app.ts"] }),
      payloadSchema: {
        type: "object",
        properties: { changed_files: { type: "array", items: { type: "string" } } },
        required: ["changed_files"],
      },
    });
    expect(calls).toBe(0);
    expect(outcome.outcome).toBe("passed");
  });

  it("stops after a cancelled function check without adding the rest", async () => {
    const calls: string[] = [];
    const outcome = await runCompletionContract(
      functionRunnerInput(functionContract(["first", "second"]), {
        async invoke(request) {
          calls.push(request.checkId);
          return { ok: false, code: "cancelled", message: "cancelled", revision: request.revision };
        },
      }),
    );
    expect(calls).toEqual(["first"]);
    expect(outcome.checks.map((check) => check.check_id)).toEqual(["first"]);
    expect(outcome.checks[0]?.evidence).toMatchObject({ code: "cancelled" });
  });

  it("uses the pinned revision and does not ask for a newer one", async () => {
    const revisions: Array<number | undefined> = [];
    await runCompletionContract(
      functionRunnerInput(
        functionContract(["score"]),
        {
          async invoke(request) {
            revisions.push(request.revision);
            return { ok: true, value: { passed: true }, revision: request.revision };
          },
        },
        (functionId) => (functionId === "score" ? 1 : undefined),
      ),
    );
    expect(revisions).toEqual([1]);
  });
});

describe("function-verify fixture", () => {
  const failSource = "export default function execute() {\n  return { passed: false, message: \"low\" };\n}\n";
  const passSource = "export default function execute() {\n  return { passed: true };\n}\n";

  async function projectWithScore() {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-verify-run-"));
    const store = createRunStore({ rootDir: root });
    const db = sqliteConnectionFromStore(store);
    if (!db) throw new Error("run store has no connection");
    const service = new FunctionService({ store: new FunctionStore(db) });
    const definition = {
      id: "score",
      name: "Score",
      kind: "verification",
      source: failSource,
      capabilities: [],
      bindings: [],
    };
    await service.create(root, definition, { source: "file" });
    return { root, store, service, definition };
  }

  it("a failure envelope records no function check and does not open the next stage", async () => {
    const { root, store } = await projectWithScore();
    const base = scriptedFakeAgent([
      { type: "emit", envelope: { status: "failure", summary: "blocked", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "should not run", artifacts: [] } },
    ]);
    const opened: string[] = [];
    const agent = {
      openStage(input: StageRunInput) {
        opened.push(input.stage.id);
        return base.openStage(input);
      },
      runStage(input: StageRunInput) {
        return base.runStage(input);
      },
    };
    const result = await runPipeline({
      agent,
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: FUNCTION_FIXTURE,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(false);
    expect(opened).toEqual(["check"]);
    await expect(store.listVerificationCheckResults(result.runId, "check")).resolves.toEqual([]);
  });

  it("an after-phase failure stops at the repair attempt limit and keeps the pinned revision", async () => {
    const { root, store, service, definition } = await projectWithScore();
    const base = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "candidate one", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "candidate two", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "should not run", artifacts: [] } },
    ]);
    const opened: string[] = [];
    let edited = false;
    const agent = {
      openStage(input: StageRunInput) {
        opened.push(input.stage.id);
        const handle = base.openStage(input);
        const next = handle.next.bind(handle);
        handle.next = async () => {
          if (!edited && input.stage.id === "check") {
            edited = true;
            const saved = await service.save(
              root,
              "score",
              { baseRevision: 1, definition: { ...definition, source: passSource } },
              { source: "file" },
            );
            expect(saved.revision).toBe(2);
          }
          return next();
        };
        return handle;
      },
      runStage(input: StageRunInput) {
        return base.runStage(input);
      },
    };
    const result = await runPipeline({
      agent,
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: FUNCTION_FIXTURE,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      reason: "Completion verification failed: score",
    });
    expect(opened).toEqual(["check", "check"]);
    await expect(store.countStageAttempts(result.runId, "check")).resolves.toBe(2);
    const first = await store.listVerificationCheckResults(result.runId, "check", 1);
    const second = await store.listVerificationCheckResults(result.runId, "check", 2);
    expect(first).toMatchObject([{ check_id: "score", status: "failed", evidence: { revision: 1 } }]);
    expect(second).toMatchObject([{ check_id: "score", status: "failed", evidence: { revision: 1 } }]);
    expect(await service.getPin(root, "run", result.runId, "score")).toMatchObject({ revision: 1 });
  });
});

describe.skipIf(process.platform === "win32")("nodeCommandExecutor process-group timeout", () => {
  it("kills verify descendants when command exceeds timeout_ms", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verify-timeout-"));
    const pidFile = path.join(root, "grandchild.pid");
    const fixture = fileURLToPath(
      new URL("./fixtures/verifyHangWithGrandchild.mjs", import.meta.url),
    );
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
    const previous = process.env.VERIFY_GRANDCHILD_PID_FILE;
    process.env.VERIFY_GRANDCHILD_PID_FILE = pidFile;

    try {
      const runPromise = nodeCommandExecutor.run({
        command,
        cwd: root,
        timeout_ms: 200,
      });

      await vi.waitFor(
        async () => {
          const raw = await readFile(pidFile, "utf8");
          expect(Number(raw)).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );
      const grandchildPid = Number(await readFile(pidFile, "utf8"));

      const result = await runPromise;
      expect(result.timed_out).toBe(true);

      await vi.waitFor(
        () => {
          let alive = true;
          try {
            process.kill(grandchildPid, 0);
          } catch {
            alive = false;
          }
          expect(alive).toBe(false);
        },
        { timeout: 4000 },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.VERIFY_GRANDCHILD_PID_FILE;
      } else {
        process.env.VERIFY_GRANDCHILD_PID_FILE = previous;
      }
    }
  });
});

describe.skipIf(process.platform === "win32")("nodeCommandExecutor bash", () => {
  it("runs bashisms via bash -c with curated env", async () => {
    const result = await nodeCommandExecutor.run({
      command: '[[ -n "$SF_VERIFY_MARK" ]] && echo ok',
      cwd: process.cwd(),
      env: { ...process.env, SF_VERIFY_MARK: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
