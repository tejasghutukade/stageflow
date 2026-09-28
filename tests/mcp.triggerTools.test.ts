import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { startTestService } from "./helpers/testInProcessService.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const triggerFixture = path.join(fixtures, "triggers", "manual-hello-world.trigger.yaml");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");

async function seedCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
  await writeFile(
    path.join(root, "triggers", "manual-hello-world.trigger.yaml"),
    await readFile(triggerFixture, "utf8"),
  );
}

function successEnvelope(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
      payload: {},
    },
  };
}

describe("MCP trigger tools", () => {
  it("list_triggers returns the fixture trigger; get_trigger success + unknown-id 404", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const listed = await mcpCall(service.baseUrl, "list_triggers");
        expect(listed.isError).toBe(false);
        expect(listed.payload.triggers).toHaveLength(1);
        expect(listed.payload.triggers[0]).toMatchObject({
          id: "manual-hello-world",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
          enabled: true,
        });

        const shown = await mcpCall(service.baseUrl, "get_trigger", {
          id: "manual-hello-world",
        });
        expect(shown.isError).toBe(false);
        expect(shown.payload).toMatchObject({ id: "manual-hello-world" });

        const missing = await mcpCall(service.baseUrl, "get_trigger", {
          id: "no-such-trigger",
        });
        expect(missing.isError).toBe(true);
        expect(missing.payload.status).toBe(404);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fire_trigger starts a real run and updates the store; unknown id 404", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-fire-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const fired = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "manual-hello-world",
        });
        expect(fired.isError).toBe(false);
        expect(typeof fired.payload.runId).toBe("string");

        const run = await store.readRun(fired.payload.runId);
        expect(run.pipeline_id).toBe("hello");

        const trigger = await store.getTrigger("manual-hello-world");
        expect(trigger?.last_run_id).toBe(fired.payload.runId);

        const missing = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "no-such-trigger",
        });
        expect(missing.isError).toBe(true);
        expect(missing.payload.status).toBe(404);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("create_trigger writes a real trigger visible via list_triggers; rejects dangling refs, bad cron, and duplicate ids", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-create-"));
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const danglingRef = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "dangling",
          pipeline: "no-such-pipeline",
          task: "my-task",
          kind: "manual",
        });
        expect(danglingRef.isError).toBe(true);
        expect(danglingRef.payload.status).toBe(422);
        expect(danglingRef.payload.error).toMatch(/unknown pipeline/);

        const badCron = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "bad-cron",
          pipeline: "hello",
          task: "my-task",
          kind: "schedule",
          schedule: { cron: "not a cron" },
        });
        expect(badCron.isError).toBe(true);
        expect(badCron.payload.status).toBe(422);
        expect(badCron.payload.error).toMatch(/Invalid schedule.cron/);

        const duplicate = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "manual-hello-world",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
        });
        expect(duplicate.isError).toBe(true);
        expect(duplicate.payload.status).toBe(409);

        const created = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "nightly-hello",
          pipeline: "hello",
          task: "my-task",
          kind: "schedule",
          schedule: { cron: "0 2 * * *", timezone: "UTC" },
        });
        expect(created.isError).toBe(false);
        expect(created.payload).toMatchObject({
          id: "nightly-hello",
          pipeline: "hello",
          task: "my-task",
          kind: "schedule",
          enabled: true,
        });

        const writtenPath = path.join(root, "triggers", "nightly-hello.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("id: nightly-hello");

        const listed = await mcpCall(service.baseUrl, "list_triggers");
        expect(listed.isError).toBe(false);
        expect(listed.payload.triggers.map((t: { id: string }) => t.id)).toContain(
          "nightly-hello",
        );
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fire_trigger on a disabled trigger returns 409 and does not create a run", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "manual-disabled.trigger.yaml"),
        "id: manual-disabled\npipeline: hello\ntask: my-task\nkind: manual\nenabled: false\n",
      );
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-disabled-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const fired = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "manual-disabled",
        });
        expect(fired.isError).toBe(true);
        expect(fired.payload.status).toBe(409);
        expect(fired.payload.error).toMatch(/disabled/i);

        expect(await store.getTrigger("manual-disabled")).toBeNull();
        expect((await store.listRuns()).length).toBe(0);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
