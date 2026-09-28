import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { fireTrigger } from "../src/runtime/triggerRunner.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const triggerFixture = path.join(fixtures, "triggers", "manual-hello-world.trigger.yaml");
const dynamicTriggerFixture = path.join(fixtures, "triggers", "dynamic-hello.trigger.yaml");
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
  await writeFile(
    path.join(root, "triggers", "dynamic-hello.trigger.yaml"),
    await readFile(dynamicTriggerFixture, "utf8"),
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

describe("fireTrigger", () => {
  it("fires the manual-hello-world fixture trigger and records the run", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const runManager = new RunManager({ agent, cwd: root, store });

      const result = await fireTrigger("manual-hello-world", store, runManager, {
        cwd: root,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await result.done;

      const trigger = await store.getTrigger("manual-hello-world");
      expect(trigger?.last_run_id).toBe(result.runId);
      expect(trigger?.last_fired_at).toEqual(expect.any(String));

      const run = await store.readRun(result.runId);
      expect(run.pipeline_id).toBe("hello");
      expect(run.task_id).toBe("my-task");

      while (runManager.getActiveCount() > 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns not-found for an unknown trigger id", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const runManager = new RunManager({
        agent: scriptedFakeAgent([]),
        cwd: root,
        store,
      });

      const result = await fireTrigger("no-such-trigger", store, runManager, { cwd: root });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fires the dynamic-hello fixture trigger with a supplied task and starts a real run", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const runManager = new RunManager({ agent, cwd: root, store });

      const result = await fireTrigger("dynamic-hello", store, runManager, {
        cwd: root,
        task: { id: "inline-task", goal: "Say hello dynamically" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await result.done;

      const trigger = await store.getTrigger("dynamic-hello");
      expect(trigger?.last_run_id).toBe(result.runId);

      const run = await store.readRun(result.runId);
      expect(run.pipeline_id).toBe("hello");
      expect(run.task_id).toBe("inline-task");

      while (runManager.getActiveCount() > 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("rejects firing the dynamic-hello fixture trigger with no task supplied", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const runManager = new RunManager({
        agent: scriptedFakeAgent([]),
        cwd: root,
        store,
      });

      const result = await fireTrigger("dynamic-hello", store, runManager, { cwd: root });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.code).toBe("trigger.task_required");
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("rejects firing the manual-hello-world fixture trigger with a task override supplied", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const runManager = new RunManager({
        agent: scriptedFakeAgent([]),
        cwd: root,
        store,
      });

      const result = await fireTrigger("manual-hello-world", store, runManager, {
        cwd: root,
        task: { id: "inline-task", goal: "Say hello dynamically" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.code).toBe("trigger.task_override_not_allowed");
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
