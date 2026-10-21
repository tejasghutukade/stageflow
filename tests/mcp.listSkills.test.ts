import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { runSkillsDir } from "../src/runtime/runSkills.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { netPipeline } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

let catalogRoot: string;
let cleanupCatalogRoot: () => Promise<void>;

beforeAll(async () => {
  const setup = await initTempGitRepo();
  catalogRoot = setup.root;
  cleanupCatalogRoot = setup.cleanup;
  await cp(path.join(fixtures, "pipelines"), path.join(catalogRoot, "pipelines"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "tasks"), path.join(catalogRoot, "tasks"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "stages"), path.join(catalogRoot, "stages"), {
    recursive: true,
  });
  await writeFile(
    path.join(catalogRoot, "stageflow.yaml"),
    [
      "version: 1",
      "catalog:",
      "  pipelines:",
      "    - pipelines",
      "  tasks:",
      "    - tasks",
      "  patterns:",
      '    pipeline: "*.yaml"',
      '    task: "*.yaml"',
      "",
    ].join("\n"),
  );
  clearFindProjectRootCacheForTests();
});

afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanupCatalogRoot();
});

function completedAgent() {
  return {
    openStage(input: { stage: { id: string } }) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => ({
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
            payload: {},
          },
        }),
      });
    },
    async runStage() {
      return {
        ok: true as const,
        envelope: {
          status: "success" as const,
          summary: "ok",
          artifacts: [],
          payload: {},
        },
      };
    },
  };
}

describe("mcp list_skills", () => {
  it("lists host skills and run-scoped origin with runId", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-list-skills-"));
    const agentDir = path.join(rootDir, "agent");
    await mkdir(path.join(agentDir, "skills", "host-skill"), {
      recursive: true,
    });
    await writeFile(
      path.join(agentDir, "skills", "host-skill", "SKILL.md"),
      "---\nname: host-skill\ndescription: Host fixture.\n---\n# Host\n",
      "utf8",
    );

    const store = createRunStore({ rootDir });
    await store.ensureProject(catalogRoot);
    const { server, manager } = await startUiServer({
      agent: completedAgent(),
      cwd: catalogRoot,
      rootDir,
      store,
      agentDir,
      port: 0,
      uiDistDir: path.join(rootDir, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const hostList = await mcpCall(url, "list_skills", {});
      expect(hostList.isError).toBe(false);
      const hostSkills = hostList.payload.skills as Array<{
        name: string;
        origin: string;
      }>;
      expect(hostSkills.some((s) => s.name === "host-skill")).toBe(true);
      expect(
        hostSkills.find((s) => s.name === "host-skill")?.origin,
      ).toBe("host");

      const start = await mcpCall(url, "start_run", {
        pipeline: {
          id: "skill-pipe",
          stages: [
            {
              id: "s1",
              system_prompt: "do",
              model: "anthropic/claude-sonnet-4-5",
              skill: "run-skill",
              ...REQUIRED_IO,
            },
          ],
        },
        task: { id: "t", goal: "g" },
        skills: {
          "run-skill": {
            "SKILL.md":
              "---\nname: run-skill\ndescription: Run fixture.\n---\n# Run\n",
          },
        },
      });
      expect(start.isError).toBe(false);
      const runId = start.payload.runId as string;

      const runList = await mcpCall(url, "list_skills", { runId });
      expect(runList.isError).toBe(false);
      const runListed = runList.payload.skills as Array<{
        name: string;
        description: string;
        origin: string;
      }>;
      expect(runListed.find((s) => s.name === "run-skill")).toEqual({
        name: "run-skill",
        description: "Run fixture.",
        origin: "run",
      });

      const skillsPath = runSkillsDir(store.getWorkspaceDir(runId));
      expect(skillsPath).toContain(path.join("runs", runId, "skills"));

      await manager!.deleteRun(runId, { force: true, channel: "rest" });
      const gone = await mcpCall(url, "list_skills", { runId });
      expect(gone.isError).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("rejects bad skills before creating a Run", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-skills-reject-"));
    const store = createRunStore({ rootDir });
    await store.ensureProject(catalogRoot);
    const { server } = await startUiServer({
      agent: completedAgent(),
      cwd: catalogRoot,
      rootDir,
      store,
      port: 0,
      uiDistDir: path.join(rootDir, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const before = await store.listRuns();
      const bad = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "t", goal: "g" },
        skills: {
          "evil/name": {
            "SKILL.md":
              "---\nname: evil\ndescription: Bad.\n---\n# Bad\n",
          },
        },
      });
      expect(bad.isError).toBe(true);
      expect(bad.payload.code).toBe("skills_invalid_name");
      expect((await store.listRuns()).length).toBe(before.length);

      const missingMd = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "t2", goal: "g" },
        skills: {
          archify: { "scripts/x.sh": "echo" },
        },
      });
      expect(missingMd.isError).toBe(true);
      expect(missingMd.payload.code).toBe("skills_missing_skill_md");
      expect((await store.listRuns()).length).toBe(before.length);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
