import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runMigrateYamlCommand } from "../src/cli/migrateYamlCommand.js";
import { applyMigrateYamlPlan, planMigrateYaml } from "../src/config/migrateYaml.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { validatePipeline } from "../src/config/validateCatalog.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const MODEL = "anthropic/claude-sonnet-4-5";

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function git(rootDir: string, args: string[]): void {
  execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
}

async function commitAll(rootDir: string, message: string): Promise<void> {
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-m", message]);
}

function captureIo(): { logs: string[]; errors: string[]; io: { log: (line: string) => void; error: (line: string) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  };
}

const workStageYaml = [
  "id: work",
  "system_prompt: do the work",
  `model: ${MODEL}`,
  "payload_schema:",
  "  type: object",
  "clone_input_schema:",
  "  type: object",
  "pre_emit_checks:",
  "  - id: declared",
  "    type: artifact_declared",
  "    basename: report.md",
  "",
].join("\n");

const workPipelineYaml = [
  "id: work-pipe",
  "stages:",
  "  - id: work",
  "    uses: ../stages/work.yaml",
  "    completion:",
  "      mode: all",
  "      checks:",
  "        - id: tests",
  "          type: command",
  "          run: npm test",
  "    recovery:",
  "      mode: repair",
  "      max_attempts: 3",
  "      retry_safety: idempotent",
  "      include_failed_checks: true",
  "",
].join("\n");

async function tmpNamesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith(".tmp"));
}

async function writeUsesCatalog(
  catalogRoot: string,
  options?: { pipelineYaml?: string; stageYaml?: string },
): Promise<{ pipelinePath: string; stagePath: string }> {
  const pipelinesDir = path.join(catalogRoot, "pipelines");
  const stagesDir = path.join(catalogRoot, "stages");
  await mkdir(pipelinesDir, { recursive: true });
  await mkdir(stagesDir, { recursive: true });
  const pipelinePath = path.join(pipelinesDir, "work.pipeline.yaml");
  const stagePath = path.join(stagesDir, "work.yaml");
  await writeFile(pipelinePath, options?.pipelineYaml ?? workPipelineYaml);
  await writeFile(stagePath, options?.stageYaml ?? workStageYaml);
  return { pipelinePath, stagePath };
}

function comparableIr(loaded: Awaited<ReturnType<typeof loadPipeline>>) {
  return {
    stages: loaded.stages.map((stage) => ({
      id: stage.id,
      payload_schema: stage.payload_schema,
      clone_input_schema: stage.clone_input_schema,
      pre_emit_checks: stage.pre_emit_checks,
      gate_kinds: stage.gate_kinds,
      timeout_ms: stage.timeout_ms,
      skill: stage.skill,
      mcp: stage.mcp,
    })),
    dag: loaded.dag.nodes.map((node) => ({
      id: node.id,
      needs: node.needs,
      needsEdges: node.needsEdges,
      completion: node.completion,
      recovery: node.recovery,
      fork: node.fork,
      feedback_loop: node.feedback_loop,
      replay_safe: node.replay_safe,
    })),
  };
}

describe("sf migrate-yaml", () => {
  it("prints usage on --help", async () => {
    const cap = captureIo();
    const code = await runMigrateYamlCommand(["--help"], {
      cwd: root,
      io: cap.io,
    });
    expect(code).toBe(0);
    expect(cap.errors.join("\n")).toMatch(/sf migrate-yaml/);
    expect(cap.errors.join("\n")).toMatch(/--write/);
    expect(cap.errors.join("\n")).toMatch(/--force/);
    expect(cap.errors.join("\n")).toMatch(/--json/);
  });

  it("F2: dry-run on a legacy pipeline lists the pipeline and its uses: files and writes nothing", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      const beforePipeline = await readFile(pipelinePath, "utf8");
      const beforeStage = await readFile(stagePath, "utf8");
      const cap = captureIo();
      const code = await runMigrateYamlCommand(["--json", pipelinePath], {
        cwd: catalogRoot,
        io: cap.io,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs[0]!) as {
        ok: boolean;
        write: boolean;
        planned: string[];
        skipped: string[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.write).toBe(false);
      expect(parsed.planned).toEqual(
        expect.arrayContaining(["pipelines/work.pipeline.yaml", "stages/work.yaml"]),
      );
      expect(parsed.planned).toHaveLength(2);
      expect(await readFile(pipelinePath, "utf8")).toBe(beforePipeline);
      expect(await readFile(stagePath, "utf8")).toBe(beforeStage);
    } finally {
      await cleanup();
    }
  });

  it("apply then apply again is a no-op", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      const first = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
          cwd: catalogRoot,
          io: first.io,
        }),
      ).toBe(0);
      const afterFirstPipeline = await readFile(pipelinePath, "utf8");
      const afterFirstStage = await readFile(stagePath, "utf8");
      await commitAll(catalogRoot, "migrated");
      const second = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
          cwd: catalogRoot,
          io: second.io,
        }),
      ).toBe(0);
      const parsed = JSON.parse(second.logs[0]!) as {
        ok: boolean;
        write: boolean;
        written?: string[];
        planned?: string[];
        skipped: string[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.written ?? parsed.planned ?? []).toEqual([]);
      expect(await readFile(pipelinePath, "utf8")).toBe(afterFirstPipeline);
      expect(await readFile(stagePath, "utf8")).toBe(afterFirstStage);
    } finally {
      await cleanup();
    }
  });

  it("does not rewrite a mixed-key file; validate still errors", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const mixed = [
        "id: mixed",
        "stages:",
        "  - id: mixed",
        "    system_prompt: test",
        `    model: ${MODEL}`,
        "    payload_schema:",
        "      type: object",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n");
      const pipelinePath = path.join(catalogRoot, "mixed.pipeline.yaml");
      await writeFile(pipelinePath, mixed);
      await commitAll(catalogRoot, "mixed");
      const cap = captureIo();
      const code = await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
        cwd: catalogRoot,
        io: cap.io,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs[0]!) as {
        ok: boolean;
        skipped: string[];
        written?: string[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.written ?? []).toEqual([]);
      expect(parsed.skipped.some((file) => file.includes("mixed.pipeline.yaml"))).toBe(
        true,
      );
      expect(await readFile(pipelinePath, "utf8")).toBe(mixed);
      const validated = await validatePipeline(pipelinePath, { cwd: catalogRoot });
      expect(validated.ok).toBe(false);
      expect(validated.findings.some((f) => f.code === "catalog.mixed_yaml_dialect")).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it("refuses a dirty git file without --force", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      await writeFile(stagePath, `${workStageYaml}# dirty\n`);
      const beforeStage = await readFile(stagePath, "utf8");
      const cap = captureIo();
      const code = await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
        cwd: catalogRoot,
        io: cap.io,
      });
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs[0] ?? cap.errors[0] ?? "{}") as {
        ok?: boolean;
      };
      const out = [...cap.logs, ...cap.errors].join("\n");
      expect(parsed.ok ?? false).toBe(false);
      expect(out).toMatch(/uncommitted|dirty|--force/i);
      expect(await readFile(stagePath, "utf8")).toBe(beforeStage);
    } finally {
      await cleanup();
    }
  });

  it("round-trips uses: plus wrapper completion to stage verify and pipeline on_verify_fail", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      const before = comparableIr(
        await loadPipeline(pipelinePath, { cwd: catalogRoot, requireIo: false }),
      );
      const cap = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", pipelinePath], {
          cwd: catalogRoot,
          io: cap.io,
        }),
      ).toBe(0);
      const afterPipeline = await readFile(pipelinePath, "utf8");
      const afterStage = await readFile(stagePath, "utf8");
      expect(afterPipeline).toMatch(/on_verify_fail:/);
      expect(afterPipeline).not.toMatch(/completion:/);
      expect(afterPipeline).not.toMatch(/recovery:/);
      expect(afterStage).toMatch(/verify:/);
      expect(afterStage).toMatch(/type: command/);
      expect(afterStage).toMatch(/type: artifact/);
      expect(afterStage).not.toMatch(/needs:/);
      expect(afterStage).not.toMatch(/on_verify_fail:/);
      const after = comparableIr(await loadPipeline(pipelinePath, { cwd: catalogRoot }));
      expect(after.stages.map(({ clone_input_schema: _, ...stage }) => stage)).toEqual(
        before.stages.map(({ clone_input_schema: _, ...stage }) => stage),
      );
      expect(after.stages[0]?.clone_input_schema).toEqual({ type: "object" });
      expect(after.dag).toEqual(before.dag);
      expect(after.dag[0]?.completion?.checks.some((check) => check.id === "tests")).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it("fails closed when two parents compile different verify lists for the same uses: path", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      await writeUsesCatalog(catalogRoot);
      await writeFile(
        path.join(catalogRoot, "pipelines", "other.pipeline.yaml"),
        [
          "id: other-pipe",
          "stages:",
          "  - id: work",
          "    uses: ../stages/work.yaml",
          "    completion:",
          "      mode: all",
          "      checks:",
          "        - id: lint",
          "          type: command",
          "          run: npm run lint",
          "",
        ].join("\n"),
      );
      await commitAll(catalogRoot, "two parents");
      const cap = captureIo();
      const code = await runMigrateYamlCommand(["--json", catalogRoot], {
        cwd: catalogRoot,
        io: cap.io,
      });
      expect(code).toBe(1);
      const out = [...cap.logs, ...cap.errors].join("\n");
      expect(out).toMatch(/work-pipe/);
      expect(out).toMatch(/other-pipe/);
      expect(out).toMatch(/work\.yaml/);
    } finally {
      await cleanup();
    }
  });

  it("does not poison a sibling parent when migrating one pipeline that shares a uses file", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      await writeFile(
        path.join(catalogRoot, "pipelines", "other.pipeline.yaml"),
        [
          "id: other-pipe",
          "stages:",
          "  - id: work",
          "    uses: ../stages/work.yaml",
          "    completion:",
          "      mode: all",
          "      checks:",
          "        - id: lint",
          "          type: command",
          "          run: npm run lint",
          "",
        ].join("\n"),
      );
      await commitAll(catalogRoot, "two parents");
      const beforeStage = await readFile(stagePath, "utf8");
      const cap = captureIo();
      const code = await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
        cwd: catalogRoot,
        io: cap.io,
      });
      expect(code).toBe(1);
      expect(await readFile(stagePath, "utf8")).toBe(beforeStage);
      const out = [...cap.logs, ...cap.errors].join("\n");
      expect(out).toMatch(/work\.yaml/);
      expect(out).toMatch(/other-pipe/);
      expect(out).not.toMatch(/type: command[\s\S]*npm run lint/);
    } finally {
      await cleanup();
    }
  });

  it("migrates a standalone stage YAML in a directory with no pipeline file", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const stagesDir = path.join(catalogRoot, "stages");
      await mkdir(stagesDir, { recursive: true });
      const stagePath = path.join(stagesDir, "orphan.yaml");
      await writeFile(stagePath, workStageYaml);
      await commitAll(catalogRoot, "standalone stage");
      const cap = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", "--json", catalogRoot], {
          cwd: catalogRoot,
          io: cap.io,
        }),
      ).toBe(0);
      const parsed = JSON.parse(cap.logs[0]!) as {
        ok: boolean;
        written?: string[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.written?.some((file) => file.includes("orphan.yaml"))).toBe(true);
      const after = await readFile(stagePath, "utf8");
      expect(after).toMatch(/io:/);
      expect(after).toMatch(/verify:/);
      expect(after).not.toMatch(/payload_schema:/);
      expect(after).not.toMatch(/pre_emit_checks:/);
    } finally {
      await cleanup();
    }
  });

  it("does not rewrite .stageflow snapshots", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath } = await writeUsesCatalog(catalogRoot);
      const snapshotPath = path.join(
        catalogRoot,
        ".stageflow",
        "runs",
        "snap.pipeline.yaml",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const snapshot = "id: snap\npayload_schema: { type: object }\n";
      await writeFile(snapshotPath, snapshot);
      await commitAll(catalogRoot, "with snapshot");
      const cap = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", "--json", catalogRoot], {
          cwd: catalogRoot,
          io: cap.io,
        }),
      ).toBe(0);
      const parsed = JSON.parse(cap.logs[0]!) as {
        planned?: string[];
        written?: string[];
        skipped: string[];
      };
      const mentioned = [...(parsed.written ?? []), ...(parsed.planned ?? []), ...parsed.skipped];
      expect(mentioned.some((file) => file.includes(".stageflow"))).toBe(false);
      expect(await readFile(snapshotPath, "utf8")).toBe(snapshot);
      expect(await readFile(pipelinePath, "utf8")).toMatch(/on_verify_fail:/);
    } finally {
      await cleanup();
    }
  });

  it("mid-batch apply failure leaves the catalog unchanged", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      const plan = await planMigrateYaml(pipelinePath, { cwd: catalogRoot });
      expect(plan.errors).toEqual([]);
      expect(plan.writes.length).toBeGreaterThanOrEqual(2);
      const first = plan.writes[0]!;
      const second = plan.writes[1]!;
      const firstBefore = await readFile(first.absPath, "utf8");
      await expect(
        applyMigrateYamlPlan(plan, {
          beforeRename: async () => {
            await rm(second.absPath);
            await mkdir(second.absPath);
          },
        }),
      ).rejects.toThrow(/Failed to restore/);
      expect(await readFile(first.absPath, "utf8")).toBe(firstBefore);
      expect(await tmpNamesIn(path.dirname(first.absPath))).toEqual([]);
      expect(await tmpNamesIn(path.dirname(second.absPath))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("refuses --write outside a git checkout without --force", async () => {
    const catalogRoot = await mkdtemp(path.join(tmpdir(), "sf-migrate-nongit-"));
    try {
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot);
      const beforePipeline = await readFile(pipelinePath, "utf8");
      const beforeStage = await readFile(stagePath, "utf8");
      const refused = captureIo();
      const refusedCode = await runMigrateYamlCommand(["--write", "--json", pipelinePath], {
        cwd: catalogRoot,
        io: refused.io,
      });
      expect(refusedCode).toBe(1);
      const refusedOut = [...refused.logs, ...refused.errors].join("\n");
      expect(refusedOut).toMatch(/uncommitted|--force/i);
      expect(await readFile(pipelinePath, "utf8")).toBe(beforePipeline);
      expect(await readFile(stagePath, "utf8")).toBe(beforeStage);

      const forced = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", "--force", "--json", pipelinePath], {
          cwd: catalogRoot,
          io: forced.io,
        }),
      ).toBe(0);
      const parsed = JSON.parse(forced.logs[0]!) as { ok: boolean; written?: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.written?.length).toBeGreaterThan(0);
      expect(await readFile(stagePath, "utf8")).toMatch(/io:/);
      expect(await readFile(pipelinePath, "utf8")).not.toBe(beforePipeline);
    } finally {
      await rm(catalogRoot, { recursive: true, force: true });
    }
  });

  it("preserves payload_schema $ref instead of inlining pipeline schemas", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const stageYaml = [
        "id: work",
        "system_prompt: do the work",
        `model: ${MODEL}`,
        "payload_schema:",
        "  $ref: '#/schemas/story'",
        "clone_input_schema:",
        "  type: object",
        "pre_emit_checks:",
        "  - id: declared",
        "    type: artifact_declared",
        "    basename: report.md",
        "",
      ].join("\n");
      const pipelineYaml = [
        "id: work-pipe",
        "schemas:",
        "  story:",
        "    type: object",
        "    required: [title]",
        "    properties:",
        "      title:",
        "        type: string",
        "stages:",
        "  - id: work",
        "    uses: ../stages/work.yaml",
        "    completion:",
        "      mode: all",
        "      checks:",
        "        - id: tests",
        "          type: command",
        "          run: npm test",
        "",
      ].join("\n");
      const { pipelinePath, stagePath } = await writeUsesCatalog(catalogRoot, {
        pipelineYaml,
        stageYaml,
      });
      await commitAll(catalogRoot, "catalog");
      const cap = captureIo();
      expect(
        await runMigrateYamlCommand(["--write", pipelinePath], {
          cwd: catalogRoot,
          io: cap.io,
        }),
      ).toBe(0);
      const afterStage = await readFile(stagePath, "utf8");
      expect(afterStage).toMatch(/\$ref:\s*['"]?#\/schemas\/story['"]?/);
      expect(afterStage).not.toMatch(/properties:/);
      expect(afterStage).not.toMatch(/title:/);
      expect(afterStage).toMatch(/verify:/);
      expect(afterStage).toMatch(/type: command/);
      const afterPipeline = await readFile(pipelinePath, "utf8");
      expect(afterPipeline).toMatch(/schemas:/);
      expect(afterPipeline).not.toMatch(/payload_schema:/);
      expect(await tmpNamesIn(path.dirname(stagePath))).toEqual([]);
      expect(await tmpNamesIn(path.dirname(pipelinePath))).toEqual([]);
      await loadPipeline(pipelinePath, { cwd: catalogRoot });
    } finally {
      await cleanup();
    }
  });
});

describe("sf migrate-yaml CLI wiring", { timeout: 30_000 }, () => {
  it("is registered on the top-level CLI", async () => {
    const { root: catalogRoot, cleanup } = await initTempGitRepo();
    try {
      const { pipelinePath } = await writeUsesCatalog(catalogRoot);
      await commitAll(catalogRoot, "catalog");
      clearFindProjectRootCacheForTests();
      const help = runCli(["migrate-yaml", "--help"], catalogRoot);
      expect(help.status).toBe(0);
      expect(help.stdout + help.stderr).toMatch(/sf migrate-yaml/);
      const dry = runCli(["migrate-yaml", "--json", pipelinePath], catalogRoot);
      expect(dry.status).toBe(0);
      const parsed = JSON.parse(dry.stdout) as { ok: boolean; write: boolean; planned: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.write).toBe(false);
      expect(parsed.planned.length).toBeGreaterThan(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
