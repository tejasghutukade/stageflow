import { describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInitCommand } from "../src/cli/initCommand.js";
import {
  HELLO_PIPELINE_YAML,
  HELLO_TASK_YAML,
  STAGEFLOW_YAML,
} from "../src/cli/initTemplates.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("runInitCommand", () => {
  it("AE6: scaffolds manifest, pipeline, task, and global home in fresh git repo", async () => {
    await withIsolatedHome(async (home) => {
      const { root: repoRoot, cleanup } = await initTempGitRepo();
      try {
        const logs: string[] = [];
        const code = await runInitCommand([], {
          cwd: repoRoot,
          io: { log: (line) => logs.push(line), error: () => undefined },
        });
        expect(code).toBe(0);
        expect(logs).toContain("Created stageflow.yaml");
        expect(logs).toContain("Created pipelines/hello.pipeline.yaml");
        expect(logs).toContain("Created tasks/hello.task.yaml");

        expect(await readFile(path.join(repoRoot, "stageflow.yaml"), "utf8")).toBe(
          STAGEFLOW_YAML,
        );
        expect(
          await readFile(path.join(repoRoot, "pipelines/hello.pipeline.yaml"), "utf8"),
        ).toBe(HELLO_PIPELINE_YAML);
        expect(await readFile(path.join(repoRoot, "tasks/hello.task.yaml"), "utf8")).toBe(
          HELLO_TASK_YAML,
        );
        await access(path.join(home, ".stageflow", "agent"));
      } finally {
        await cleanup();
      }
    });
  });

  it("AE6: second init skips existing files", async () => {
    await withIsolatedHome(async () => {
      const { root: repoRoot, cleanup } = await initTempGitRepo();
      try {
        const first = await runInitCommand([], {
          cwd: repoRoot,
          io: { log: () => undefined, error: () => undefined },
        });
        expect(first).toBe(0);

        const logs: string[] = [];
        const second = await runInitCommand([], {
          cwd: repoRoot,
          io: { log: (line) => logs.push(line), error: () => undefined },
        });
        expect(second).toBe(0);
        expect(logs).toContain("Skipped stageflow.yaml (exists)");
        expect(logs).toContain("Skipped pipelines/hello.pipeline.yaml (exists)");
        expect(logs).toContain("Skipped tasks/hello.task.yaml (exists)");
      } finally {
        await cleanup();
      }
    });
  });

  it("AE7: writes files under cwd when outside git", async () => {
    await withIsolatedHome(async (home) => {
      const outside = await mkdtemp(path.join(tmpdir(), "sf-init-outside-"));
      const logs: string[] = [];
      const code = await runInitCommand([], {
        cwd: outside,
        io: { log: (line) => logs.push(line), error: () => undefined },
      });
      expect(code).toBe(0);
      expect(logs).toContain("Created stageflow.yaml");
      await access(path.join(outside, "stageflow.yaml"));
      await access(path.join(home, ".stageflow", "agent"));
    });
  });

  it("creates only missing files when manifest already exists", async () => {
    await withIsolatedHome(async () => {
      const { root: repoRoot, cleanup } = await initTempGitRepo();
      try {
        await writeFile(path.join(repoRoot, "stageflow.yaml"), STAGEFLOW_YAML);
        const logs: string[] = [];
        const code = await runInitCommand([], {
          cwd: repoRoot,
          io: { log: (line) => logs.push(line), error: () => undefined },
        });
        expect(code).toBe(0);
        expect(logs).toContain("Skipped stageflow.yaml (exists)");
        expect(logs).toContain("Created pipelines/hello.pipeline.yaml");
        expect(logs).toContain("Created tasks/hello.task.yaml");
      } finally {
        await cleanup();
      }
    });
  });

  it("init --help prints usage and exits zero", async () => {
    const errors: string[] = [];
    const code = await runInitCommand(["--help"], {
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(0);
    expect(errors.join("\n")).toMatch(/sf init/);
  });
});

describe("sf init integration", () => {
  it("AE8: sf --help lists init", () => {
    const result = runCli(["--help"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf init/);
  });

  it("init --help via subprocess", async () => {
    await withIsolatedHome(async () => {
      const outside = await mkdtemp(path.join(tmpdir(), "sf-init-cli-"));
      const result = runCli(["init", "--help"], outside);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/sf init/);
    });
  });
});
