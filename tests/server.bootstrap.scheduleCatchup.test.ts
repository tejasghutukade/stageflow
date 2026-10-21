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

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const scheduleFixture = path.join(fixtures, "triggers", "schedule-every-minute.trigger.yaml");
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
    path.join(root, "triggers", "schedule-every-minute.trigger.yaml"),
    await readFile(scheduleFixture, "utf8"),
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

describe("Host boot schedule catch-up", () => {
  // Disabled until the live-clock assertion is made independent of minute boundaries.
  it.skip("fires exactly once for a trigger whose next_run_at already passed while the Host was down, then reschedules it", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-schedule-catchup-home-"));
      const store = createRunStore({ rootDir: homeRoot });

      await store.upsertTrigger({
        id: "schedule-every-minute",
        definitionRef: "triggers/schedule-every-minute.trigger.yaml",
        enabled: true,
      });
      const pastDueAt = "2020-01-01T00:00:00.000Z";
      await store.setTriggerNextRun("schedule-every-minute", pastDueAt);

      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const runs = await store.listRuns();
        const triggerRuns = runs.filter((run) => run.pipeline_id === "hello");
        expect(triggerRuns).toHaveLength(1);

        const trigger = await store.getTrigger("schedule-every-minute");
        expect(trigger?.last_run_id).toBe(triggerRuns[0]!.run_id);
        expect(trigger?.next_run_at).toBeDefined();
        expect(new Date(trigger!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
        expect(trigger!.next_run_at).not.toBe(pastDueAt);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
