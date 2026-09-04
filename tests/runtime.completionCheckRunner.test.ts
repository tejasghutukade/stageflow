import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  runCompletionContract,
  type CheckoutCapability,
  type CommandExecutor,
  type GateDecisionProvider,
} from "../src/runtime/completionCheckRunner.js";
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
