import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { assertEnvelopePayload } from "../envelope/payloadSchema.js";
import type { CompletionCheck, CompletionContract } from "../types/completion.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { StageGateKind } from "../types/stage.js";

/**
 * The result of executing a pipeline-owned command. Command execution is a
 * runtime capability so callers can supply a sandboxed implementation.
 */
export type CommandExecution = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  error?: string;
};

export type CommandExecutionInput = {
  command: string;
  cwd: string;
  timeout_ms?: number;
};

export type CommandExecutor = {
  run(input: CommandExecutionInput): Promise<CommandExecution>;
};

/** A completed operator interaction, normalized outside the agent adapter. */
export type GateDecision = {
  kind: StageGateKind;
  status: "accepted" | "rejected" | "answered";
  prompt_id?: string;
};

export type GateDecisionProvider = {
  listDecisions(kind: StageGateKind): Promise<readonly GateDecision[]>;
};

/**
 * A VCS-neutral checkout baseline. `fingerprint` is owned by the provider:
 * for example, a blob hash, an mtime/content hash pair, or a Git index value.
 */
export type CheckoutSnapshot = {
  entries: readonly { path: string; fingerprint: string }[];
};

export type CheckoutChange = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
};

export type CheckoutCapability = {
  capture(): Promise<CheckoutSnapshot>;
  changesSince(before: CheckoutSnapshot): Promise<readonly CheckoutChange[]>;
};

/** The agent's explicit acknowledgement of every item in one checklist. */
export type ChecklistAttestation = {
  check_id: string;
  items: readonly string[];
};

export type CompletionCheckRunnerInput = {
  contract: CompletionContract;
  envelope: StageEnvelope;
  /** The stage's declared payload_schema, when it has one. */
  payloadSchema?: unknown;
  /** Absolute attempt artifact directory. */
  artifactsDir: string;
  /** Base directory used for a command check without its own cwd. */
  commandWorkingDirectory?: string;
  commandExecutor?: CommandExecutor;
  gates?: GateDecisionProvider;
  /** Captured before the agent attempt began. */
  checkoutBefore?: CheckoutSnapshot;
  checkout?: CheckoutCapability;
  /** Why the runtime could not establish the required pre-stage baseline. */
  checkoutError?: string;
  checklistAttestations?: readonly ChecklistAttestation[];
  onCheckStart?: (check: CompletionCheck) => Promise<void> | void;
  onCheckComplete?: (result: CompletionCheckResult) => Promise<void> | void;
};

export type CommandCheckEvidence = {
  kind: "command";
  command: string;
  cwd?: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  error?: string;
};

export type ArtifactCheckEvidence = {
  kind: "artifact";
  path: string;
  exists: boolean;
  file_type: "file" | "directory" | "symlink" | "other" | "missing";
  size_bytes?: number;
  sha256?: string;
};

export type PayloadSchemaCheckEvidence = {
  kind: "payload_schema";
  schema_declared: boolean;
  payload_present: boolean;
  validation_error?: string;
};

export type GateCheckEvidence = {
  kind: "gate";
  gate_kind: StageGateKind;
  decisions: GateDecision[];
};

export type CheckoutChangesCheckEvidence = {
  kind: "checkout_changes";
  changes: CheckoutChange[];
  claimed_paths?: string[];
  missing_claimed_paths?: string[];
  unclaimed_changed_paths?: string[];
};

export type ChecklistCheckEvidence = {
  kind: "checklist";
  expected_items: string[];
  attested_items: string[];
  missing_items: string[];
  unexpected_items: string[];
};

export type CompletionCheckEvidence =
  | CommandCheckEvidence
  | ArtifactCheckEvidence
  | PayloadSchemaCheckEvidence
  | GateCheckEvidence
  | CheckoutChangesCheckEvidence
  | ChecklistCheckEvidence;

export type CompletionCheckResult = {
  check_id: string;
  check_type: CompletionCheck["type"];
  outcome: "passed" | "failed" | "error";
  message?: string;
  evidence: CompletionCheckEvidence;
};

export type CompletionVerificationResult = {
  outcome: "passed" | "failed";
  checks: CompletionCheckResult[];
  failed_check_ids: string[];
};

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

function captureOutput(
  chunks: Buffer[],
  chunk: Buffer,
  currentSize: number,
): number {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - currentSize;
  if (remaining <= 0) return currentSize;
  const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(accepted);
  return currentSize + accepted.byteLength;
}

/** Default Node implementation; callers may substitute a sandboxed executor. */
export const nodeCommandExecutor: CommandExecutor = {
  async run(input) {
    return new Promise<CommandExecution>((resolve) => {
      let stdoutSize = 0;
      let stderrSize = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (result: CommandExecution) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(result);
      };

      let child;
      try {
        child = spawn(input.command, {
          cwd: input.cwd,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish({
          exit_code: null,
          stdout: "",
          stderr: "",
          timed_out: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      child.stdout?.on("data", (data: Buffer) => {
        stdoutSize = captureOutput(stdout, Buffer.from(data), stdoutSize);
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderrSize = captureOutput(stderr, Buffer.from(data), stderrSize);
      });
      child.once("error", (error) => {
        finish({
          exit_code: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timed_out: timedOut,
          error: error.message,
        });
      });
      child.once("close", (code) => {
        finish({
          exit_code: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timed_out: timedOut,
        });
      });
      if (input.timeout_ms !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeout_ms);
      }
    });
  },
};

function result(
  check: CompletionCheck,
  outcome: CompletionCheckResult["outcome"],
  evidence: CompletionCheckEvidence,
  message?: string,
): CompletionCheckResult {
  return {
    check_id: check.id,
    check_type: check.type,
    outcome,
    ...(message !== undefined ? { message } : {}),
    evidence,
  };
}

function resolveCommandCwd(check: Extract<CompletionCheck, { type: "command" }>, base: string): string {
  return check.cwd === undefined ? base : path.resolve(base, check.cwd);
}

async function runCommandCheck(
  check: Extract<CompletionCheck, { type: "command" }>,
  input: CompletionCheckRunnerInput,
): Promise<CompletionCheckResult> {
  const base = input.commandWorkingDirectory;
  if (base === undefined) {
    return result(
      check,
      "error",
      { kind: "command", command: check.run, exit_code: null, stdout: "", stderr: "", timed_out: false },
      "command check requires commandWorkingDirectory",
    );
  }
  const cwd = resolveCommandCwd(check, base);
  const executor = input.commandExecutor ?? nodeCommandExecutor;
  try {
    const execution = await executor.run({ command: check.run, cwd, timeout_ms: check.timeout_ms });
    const evidence: CommandCheckEvidence = {
      kind: "command",
      command: check.run,
      cwd,
      exit_code: execution.exit_code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      timed_out: execution.timed_out,
      ...(execution.error !== undefined ? { error: execution.error } : {}),
    };
    if (execution.timed_out) return result(check, "failed", evidence, "command timed out");
    if (execution.error !== undefined) return result(check, "error", evidence, execution.error);
    if (execution.exit_code !== 0) return result(check, "failed", evidence, `command exited with code ${execution.exit_code ?? "unknown"}`);
    return result(check, "passed", evidence);
  } catch (error) {
    return result(
      check,
      "error",
      { kind: "command", command: check.run, cwd, exit_code: null, stdout: "", stderr: "", timed_out: false },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function inspectArtifact(artifactsDir: string, relativePath: string): Promise<ArtifactCheckEvidence> {
  const target = path.resolve(artifactsDir, relativePath);
  const relative = path.relative(artifactsDir, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: "artifact", path: relativePath, exists: false, file_type: "missing" };
  }
  try {
    // lstat every component rather than just the target: lstat(target) follows
    // a symlink in a parent directory, which could otherwise prove a file that
    // lives outside the attempt artifact root.
    const segments = relative.split(path.sep).filter((segment) => segment !== "");
    let current = artifactsDir;
    let stats: Stats | undefined;
    for (const segment of segments) {
      current = path.join(current, segment);
      stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return { kind: "artifact", path: relativePath, exists: true, file_type: "symlink" };
      }
      if (current !== target && !stats.isDirectory()) {
        return { kind: "artifact", path: relativePath, exists: true, file_type: "other" };
      }
    }
    if (stats === undefined) {
      return { kind: "artifact", path: relativePath, exists: false, file_type: "missing" };
    }
    if (stats.isSymbolicLink()) {
      return { kind: "artifact", path: relativePath, exists: true, file_type: "symlink" };
    }
    if (stats.isDirectory()) {
      return { kind: "artifact", path: relativePath, exists: true, file_type: "directory" };
    }
    if (!stats.isFile()) {
      return { kind: "artifact", path: relativePath, exists: true, file_type: "other" };
    }
    const content = await readFile(target);
    return {
      kind: "artifact",
      path: relativePath,
      exists: true,
      file_type: "file",
      size_bytes: stats.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "artifact", path: relativePath, exists: false, file_type: "missing" };
    }
    throw error;
  }
}

async function runArtifactCheck(
  check: Extract<CompletionCheck, { type: "artifact" }>,
  input: CompletionCheckRunnerInput,
): Promise<CompletionCheckResult> {
  try {
    const evidence = await inspectArtifact(input.artifactsDir, check.path);
    if (evidence.file_type !== "file") {
      return result(check, "failed", evidence, `artifact is ${evidence.file_type}`);
    }
    if (check.nonempty === true && evidence.size_bytes === 0) {
      return result(check, "failed", evidence, "artifact is empty");
    }
    return result(check, "passed", evidence);
  } catch (error) {
    return result(
      check,
      "error",
      { kind: "artifact", path: check.path, exists: false, file_type: "missing" },
      error instanceof Error ? error.message : String(error),
    );
  }
}

function runPayloadSchemaCheck(
  check: Extract<CompletionCheck, { type: "payload_schema" }>,
  input: CompletionCheckRunnerInput,
): CompletionCheckResult {
  const evidence: PayloadSchemaCheckEvidence = {
    kind: "payload_schema",
    schema_declared: input.payloadSchema !== undefined,
    payload_present: input.envelope.payload !== undefined,
  };
  if (input.payloadSchema === undefined) {
    evidence.validation_error = "stage does not declare payload_schema";
    return result(check, "error", evidence, evidence.validation_error);
  }
  try {
    assertEnvelopePayload(input.envelope, input.payloadSchema);
    return result(check, "passed", evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.validation_error = message;
    return result(check, "failed", evidence, message);
  }
}

async function runGateCheck(
  check: Extract<CompletionCheck, { type: "gate" }>,
  input: CompletionCheckRunnerInput,
): Promise<CompletionCheckResult> {
  const baseEvidence: GateCheckEvidence = { kind: "gate", gate_kind: check.kind, decisions: [] };
  if (!input.gates) {
    return result(check, "error", baseEvidence, "gate check requires a gate decision provider");
  }
  try {
    const decisions = [...(await input.gates.listDecisions(check.kind))]
      .filter((decision) => decision.kind === check.kind)
      .sort((a, b) => (a.prompt_id ?? "").localeCompare(b.prompt_id ?? "") || a.status.localeCompare(b.status));
    const evidence: GateCheckEvidence = { ...baseEvidence, decisions };
    const accepted = decisions.some((decision) => decision.status === "accepted");
    const answered = decisions.some((decision) => decision.status === "answered");
    const passes = check.kind === "confirm" ? accepted : accepted || answered;
    return passes
      ? result(check, "passed", evidence)
      : result(check, "failed", evidence, `no accepted ${check.kind} gate decision`);
  } catch (error) {
    return result(check, "error", baseEvidence, error instanceof Error ? error.message : String(error));
  }
}

function normalizeCheckoutPath(value: string): string | undefined {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

function claimedPaths(
  payload: Record<string, unknown> | undefined,
  fields: readonly string[] | undefined,
): { paths: string[]; invalid: string[] } {
  if (fields === undefined) return { paths: [], invalid: [] };
  const paths: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    const value = payload?.[field];
    if (!Array.isArray(value)) {
      invalid.push(field);
      continue;
    }
    for (const candidate of value) {
      if (typeof candidate !== "string") {
        invalid.push(field);
        continue;
      }
      const normalized = normalizeCheckoutPath(candidate);
      if (normalized === undefined) invalid.push(candidate);
      else paths.push(normalized);
    }
  }
  return { paths: [...new Set(paths)].sort(), invalid: [...new Set(invalid)].sort() };
}

async function runCheckoutChangesCheck(
  check: Extract<CompletionCheck, { type: "checkout_changes" }>,
  input: CompletionCheckRunnerInput,
): Promise<CompletionCheckResult> {
  const empty: CheckoutChangesCheckEvidence = { kind: "checkout_changes", changes: [] };
  if (input.checkoutError !== undefined) {
    return result(check, "error", empty, input.checkoutError);
  }
  if (!input.checkout || !input.checkoutBefore) {
    return result(check, "error", empty, "checkout check requires a before snapshot and checkout capability");
  }
  try {
    const rawChanges = await input.checkout.changesSince(input.checkoutBefore);
    const changes = [...rawChanges]
      .map((change) => ({ ...change, path: normalizeCheckoutPath(change.path) }))
      .filter((change): change is CheckoutChange => change.path !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
    const { paths, invalid } = claimedPaths(input.envelope.payload, check.path_fields);
    const changedPaths = [...new Set(changes.map((change) => change.path))];
    const evidence: CheckoutChangesCheckEvidence = {
      kind: "checkout_changes",
      changes,
      ...(check.path_fields !== undefined ? { claimed_paths: paths } : {}),
    };
    if (changes.length === 0) return result(check, "failed", evidence, "checkout has no changes from this attempt");
    if (invalid.length > 0) return result(check, "failed", evidence, `invalid claimed checkout paths: ${invalid.join(", ")}`);
    if (check.path_fields !== undefined) {
      const claimed = new Set(paths);
      const actual = new Set(changedPaths);
      const missing = paths.filter((item) => !actual.has(item));
      const unclaimed = changedPaths.filter((item) => !claimed.has(item));
      if (missing.length > 0) evidence.missing_claimed_paths = missing;
      if (unclaimed.length > 0) evidence.unclaimed_changed_paths = unclaimed;
      if (missing.length > 0 || unclaimed.length > 0) {
        return result(check, "failed", evidence, "claimed checkout paths do not match observed changes");
      }
    }
    return result(check, "passed", evidence);
  } catch (error) {
    return result(check, "error", empty, error instanceof Error ? error.message : String(error));
  }
}

function runChecklistCheck(
  check: Extract<CompletionCheck, { type: "checklist" }>,
  input: CompletionCheckRunnerInput,
): CompletionCheckResult {
  const attestation = input.checklistAttestations?.find((item) => item.check_id === check.id);
  const attested = [...new Set(attestation?.items ?? [])].sort();
  const expected = [...check.items].sort();
  const attestedSet = new Set(attested);
  const expectedSet = new Set(expected);
  const evidence: ChecklistCheckEvidence = {
    kind: "checklist",
    expected_items: expected,
    attested_items: attested,
    missing_items: expected.filter((item) => !attestedSet.has(item)),
    unexpected_items: attested.filter((item) => !expectedSet.has(item)),
  };
  if (evidence.missing_items.length > 0 || evidence.unexpected_items.length > 0) {
    return result(check, "failed", evidence, "checklist attestation does not match required items");
  }
  return result(check, "passed", evidence);
}

async function runCheck(
  check: CompletionCheck,
  input: CompletionCheckRunnerInput,
): Promise<CompletionCheckResult> {
  switch (check.type) {
    case "command":
      return runCommandCheck(check, input);
    case "artifact":
      return runArtifactCheck(check, input);
    case "payload_schema":
      return runPayloadSchemaCheck(check, input);
    case "gate":
      return runGateCheck(check, input);
    case "checkout_changes":
      return runCheckoutChangesCheck(check, input);
    case "checklist":
      return runChecklistCheck(check, input);
  }
}

/**
 * Run every completion check in declaration order. A failed check never throws
 * or prevents later checks from producing their own repair evidence.
 */
export async function runCompletionContract(
  input: CompletionCheckRunnerInput,
): Promise<CompletionVerificationResult> {
  const checks: CompletionCheckResult[] = [];
  for (const check of input.contract.checks) {
    await input.onCheckStart?.(check);
    const completed = await runCheck(check, input);
    await input.onCheckComplete?.(completed);
    checks.push(completed);
  }
  const failedCheckIds = checks
    .filter((check) => check.outcome !== "passed")
    .map((check) => check.check_id);
  return {
    outcome: failedCheckIds.length === 0 ? "passed" : "failed",
    checks,
    failed_check_ids: failedCheckIds,
  };
}
