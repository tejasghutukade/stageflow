import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_USAGE,
  runArtifactCommand,
} from "../src/cli/artifactCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function seedArtifact(
  projectRoot: string,
  relPath: string,
  contents: string,
): Promise<{ runId: string; workspaceDir: string }> {
  const store = createRunStore({ rootDir: projectRoot });
  const created = await store.createRun({
    pipelineId: "docs-only",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
  });
  const fullPath = path.join(created.workspaceDir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
  return { runId: created.runId, workspaceDir: created.workspaceDir };
}

describe("runArtifactCommand", () => {
  it("prints artifact contents to stdout", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-read-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "hello artifact");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout.join("\n")).toBe("hello artifact");
    expect(stderr).toEqual([]);
  });

  it("writes artifact to --out and leaves stdout empty", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-out-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "saved content");
    const outFile = path.join(projectRoot, "copied.txt");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel, "--out", "copied.txt"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: (line) => stdout.push(line),
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/Wrote .*copied\.txt/);
    await expect(readFile(outFile, "utf8")).resolves.toBe("saved content");
  });

  it("rejects input path traversal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-in-traversal-"));
    const { runId } = await seedArtifact(projectRoot, "stages/s1/out.txt", "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", "../../etc/passwd"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/path must not contain \.\. segments/);
  });

  it("rejects output path traversal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-out-traversal-"));
    const rel = path.join("stages", "s1", "out.txt");
    const { runId } = await seedArtifact(projectRoot, rel, "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      [
        "read",
        "--run",
        runId,
        "--path",
        rel,
        "--out",
        "../../../etc/passwd",
      ],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/path must not contain \.\. segments/);
  });

  it("denies .pi-agent/auth.json paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-deny-"));
    const rel = path.join("stages", "s1", ".pi-agent", "auth.json");
    const { runId } = await seedArtifact(
      projectRoot,
      rel,
      JSON.stringify({ secret: "nope" }),
    );

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", runId, "--path", rel],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Artifact path denied/);
  });

  it("exits 1 for unknown run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-unknown-run-"));

    const stderr: string[] = [];
    const code = await runArtifactCommand(
      ["read", "--run", "missing-run-id", "--path", "stages/s1/out.txt"],
      {
        cwd: projectRoot,
        projectRoot,
        io: {
          log: () => undefined,
          error: (line) => stderr.push(line),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Run not found: missing-run-id/);
  });

  it("prints usage when --path is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-art-missing-path-"));
    const { runId } = await seedArtifact(projectRoot, "stages/s1/out.txt", "x");

    const stderr: string[] = [];
    const code = await runArtifactCommand(["read", "--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/Missing --run and\/or --path/);
    expect(stderr.join("\n")).toMatch(/sf artifact read/);
  });

  it("prints usage on --help", async () => {
    const stderr: string[] = [];
    const code = await runArtifactCommand(["read", "--help"], {
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toBe(ARTIFACT_USAGE);
  });
});

describe("CLI artifact read", { timeout: 15_000 }, () => {
  it("artifact read --help shows usage and exits zero", () => {
    const result = runCli(["artifact", "read", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf artifact read/);
    expect(out).toMatch(/--run <runId>/);
    expect(out).toMatch(/--path <relPath>/);
    expect(out).toMatch(/--out <file>/);
  });

  it("top-level --help lists artifact read", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf artifact read/);
  });
});
