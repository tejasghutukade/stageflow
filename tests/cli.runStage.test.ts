import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runRunStageCommand,
  type RunStageCallFn,
  type RunStageToolArgs,
} from "../src/cli/runStageCommand.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
    stdoutText() {
      return stdout.join("\n");
    },
    stderrText() {
      return stderr.join("\n");
    },
  };
}

describe("sf run-stage --help / wiring", () => {
  it("sf run-stage --help prints usage mentioning --blocking, --envelope-ref and --model", () => {
    const result = runCli(["run-stage", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/--blocking/);
    expect(out).toMatch(/--envelope-ref/);
    expect(out).toMatch(/--model/);
  });

  it("top-level --help mentions sf run-stage", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf run-stage/);
  });

  it(
    "does not collide with `sf internal run-stage`",
    () => {
      // The internal worker entry point stays reachable under `internal`, and
      // is a totally separate dispatch branch from the new top-level command.
      const help = runCli(["run-stage", "--help"]);
      expect(help.status).toBe(0);
      // internal run-stage requires --run-id/--stage-id and is not routed here
      const internal = runCli(["internal", "run-stage"]);
      expect(internal.status).not.toBe(0);
      expect(internal.stderr + internal.stdout).toMatch(/--run-id/);
    },
    // Two real tsx subprocess spawns — the default 5s timeout can flake
    // under full-suite parallel load (CPU contention across 200+ files).
    15000,
  );
});

describe("sf run-stage arg validation", () => {
  it("requires exactly one of --stage / --stage-inline", async () => {
    const cap = captureIo();
    const callTool = vi.fn();
    const code = await runRunStageCommand(
      ["--task", "tasks/sample.task.yaml"],
      { io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/--stage/);
  });

  it("requires exactly one of --task / --task-inline / --envelope-ref", async () => {
    const cap = captureIo();
    const callTool = vi.fn();
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml"],
      { io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/--task|--envelope-ref/);
  });

  it("rejects an invalid --envelope-ref shape", async () => {
    const cap = captureIo();
    const callTool = vi.fn();
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--envelope-ref", "just-a-runid"],
      { io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/envelope-ref/);
  });

  it("rejects invalid JSON for --stage-inline", async () => {
    const cap = captureIo();
    const callTool = vi.fn();
    const code = await runRunStageCommand(
      ["--stage-inline", "{not json", "--task", "tasks/sample.task.yaml"],
      { io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/--stage-inline/);
  });

  it("unknown flag exits 1 without calling the tool", async () => {
    const cap = captureIo();
    const callTool = vi.fn();
    const code = await runRunStageCommand(["--nope"], { io: cap.io, callTool });
    expect(code).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/Unknown flag: --nope/);
  });
});

describe("sf run-stage call shapes", () => {
  it("async mode (default): passes catalog-relative stage/task and project_root", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.stage).toBe("stages/check.yaml");
      expect(args.task_path).toBe("tasks/sample.task.yaml");
      expect(args.project_root).toBe(path.resolve("/proj"));
      expect(args.blocking).toBeUndefined();
      return { isError: false, payload: { runId: "run-1", stageId: "check" } };
    });
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(0);
    expect(cap.stdoutText()).toMatch(/run-1/);
  });

  it("async mode --json prints the raw { runId, stageId } payload on stdout", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: false,
      payload: { runId: "run-1", stageId: "check" },
    }));
    const code = await runRunStageCommand(
      ["--json", "--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdoutText()) as { runId: string; stageId: string };
    expect(parsed).toEqual({ runId: "run-1", stageId: "check" });
    expect(cap.stderrText()).toBe("");
  });

  it("blocking mode: passes blocking:true and timeout_ms, exits 0 on a successful envelope", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.blocking).toBe(true);
      expect(args.timeout_ms).toBe(5000);
      return {
        isError: false,
        payload: {
          runId: "run-2",
          stageId: "check",
          status: "completed",
          envelope: { status: "success", summary: "done", artifacts: [] },
        },
      };
    });
    const code = await runRunStageCommand(
      [
        "--stage",
        "stages/check.yaml",
        "--task",
        "tasks/sample.task.yaml",
        "--blocking",
        "--timeout-ms",
        "5000",
      ],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(0);
  });

  it("blocking mode: a completed run with a failure envelope exits 1", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: false,
      payload: {
        runId: "run-3",
        stageId: "check",
        status: "completed",
        envelope: { status: "failure", summary: "boom", artifacts: [] },
      },
    }));
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml", "--blocking"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(1);
  });

  it("blocking mode: needs_input exits 2 and includes pending_prompt in --json output", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: false,
      payload: {
        runId: "run-4",
        stageId: "clarify",
        status: "needs_input",
        pending_prompt: { kind: "free_text", id: "prompt-1" },
      },
    }));
    const code = await runRunStageCommand(
      ["--json", "--stage", "stages/clarify.yaml", "--task", "tasks/sample.task.yaml", "--blocking"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdoutText()) as {
      status: string;
      pending_prompt: { kind: string; id: string };
    };
    expect(parsed.status).toBe("needs_input");
    expect(parsed.pending_prompt).toMatchObject({ kind: "free_text", id: "prompt-1" });
  });

  it("blocking mode: a timeout result exits 2", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: false,
      payload: { runId: "run-5", stageId: "check", status: "timeout" },
    }));
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml", "--blocking"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(2);
  });

  it("envelope reference input: parses runId:stageId:attempt and passes it through instead of task", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.envelope_ref).toEqual({
        runId: "prior-run",
        stageId: "research",
        attempt: 2,
      });
      expect(args.task).toBeUndefined();
      expect(args.task_path).toBeUndefined();
      return { isError: false, payload: { runId: "run-6", stageId: "summarize" } };
    });
    const code = await runRunStageCommand(
      [
        "--stage",
        "stages/summarize.yaml",
        "--envelope-ref",
        "prior-run:research:2",
      ],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(0);
  });

  it("envelope reference input without attempt omits attempt", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.envelope_ref).toEqual({ runId: "prior-run", stageId: "research" });
      return { isError: false, payload: { runId: "run-7", stageId: "summarize" } };
    });
    const code = await runRunStageCommand(
      ["--stage", "stages/summarize.yaml", "--envelope-ref", "prior-run:research"],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("repeating --envelope-ref collects multiple refs into an array", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.envelope_ref).toEqual([
        { runId: "run-a", stageId: "research" },
        { runId: "run-b", stageId: "titleize", attempt: 3 },
      ]);
      return { isError: false, payload: { runId: "run-8", stageId: "combine" } };
    });
    const code = await runRunStageCommand(
      [
        "--stage",
        "stages/combine.yaml",
        "--envelope-ref",
        "run-a:research",
        "--envelope-ref",
        "run-b:titleize:3",
      ],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("a single --envelope-ref stays a bare object, not a one-element array", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(Array.isArray(args.envelope_ref)).toBe(false);
      expect(args.envelope_ref).toEqual({ runId: "run-a", stageId: "research" });
      return { isError: false, payload: { runId: "run-9", stageId: "combine" } };
    });
    const code = await runRunStageCommand(
      ["--stage", "stages/combine.yaml", "--envelope-ref", "run-a:research"],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("model override: passed through as model", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.model).toBe("anthropic/claude-sonnet-4-5");
      return { isError: false, payload: { runId: "run-8", stageId: "check" } };
    });
    const code = await runRunStageCommand(
      [
        "--stage",
        "stages/check.yaml",
        "--task",
        "tasks/sample.task.yaml",
        "--model",
        "anthropic/claude-sonnet-4-5",
      ],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("inline stage/task JSON is parsed and passed as objects, not paths", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.stage).toEqual({ id: "check", system_prompt: "Do work" });
      expect(args.task).toEqual({ id: "t", goal: "check" });
      return { isError: false, payload: { runId: "run-9", stageId: "check" } };
    });
    const code = await runRunStageCommand(
      [
        "--stage-inline",
        JSON.stringify({ id: "check", system_prompt: "Do work" }),
        "--task-inline",
        JSON.stringify({ id: "t", goal: "check" }),
      ],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("--checkout is catalog-relativized and passed through with project_root", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args.checkout).toBe("checkouts/elsewhere");
      expect(args.stage).toBe("stages/summarize.yaml");
      expect(args.project_root).toBe(path.resolve("/proj"));
      return { isError: false, payload: { runId: "run-10", stageId: "summarize" } };
    });
    const code = await runRunStageCommand(
      [
        "--stage",
        "stages/summarize.yaml",
        "--envelope-ref",
        "prior-run:research",
        "--checkout",
        "checkouts/elsewhere",
      ],
      { cwd: "/proj", callTool },
    );
    expect(code).toBe(0);
  });

  it("with path-based stage/task, packs project_root from CLI cwd for multi-root hosts", async () => {
    const callTool: RunStageCallFn = vi.fn(async (args: RunStageToolArgs) => {
      expect(args).toMatchObject({
        stage: "stages/check.yaml",
        task_path: "tasks/sample.task.yaml",
        project_root: path.resolve("/proj-a"),
      });
      return { isError: false, payload: { runId: "run-multi", stageId: "check" } };
    });
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml"],
      { cwd: "/proj-a", callTool },
    );
    expect(code).toBe(0);
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("a tool-level error result (isError:true) prints the error and exits 1", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: true,
      payload: { error: "Stage validation failed" },
    }));
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(cap.stderrText()).toMatch(/Stage validation failed/);
  });

  it("a tool-level error result under --json prints the error payload on stdout", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => ({
      isError: true,
      payload: { error: "not found", status: 404 },
    }));
    const code = await runRunStageCommand(
      [
        "--json",
        "--stage",
        "stages/check.yaml",
        "--envelope-ref",
        "does-not-exist:whatever",
      ],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.stdoutText()) as { error: string; status: number };
    expect(parsed).toEqual({ error: "not found", status: 404 });
    expect(cap.stderrText()).toBe("");
  });

  it("a thrown error from the underlying call (e.g. ensureGlobalService failure) exits 1 with the message", async () => {
    const cap = captureIo();
    const callTool: RunStageCallFn = vi.fn(async () => {
      throw new Error("port occupied");
    });
    const code = await runRunStageCommand(
      ["--stage", "stages/check.yaml", "--task", "tasks/sample.task.yaml"],
      { cwd: "/proj", io: cap.io, callTool },
    );
    expect(code).toBe(1);
    expect(cap.stderrText()).toMatch(/port occupied/);
  });
});
