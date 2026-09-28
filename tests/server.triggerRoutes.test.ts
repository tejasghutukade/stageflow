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

describe("trigger HTTP routes", () => {
  it("GET /api/triggers lists the catalog trigger; GET /:id and POST /:id/fire round-trip", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-http-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const listRes = await fetch(`${service.baseUrl}/api/triggers`);
        expect(listRes.status).toBe(200);
        const listed = (await listRes.json()) as {
          triggers: Array<{ id: string; kind: string; enabled: boolean }>;
        };
        expect(listed.triggers).toHaveLength(1);
        expect(listed.triggers[0]).toMatchObject({
          id: "manual-hello-world",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
          enabled: true,
        });
        expect(listed.triggers[0]!.last_fired_at).toBeUndefined();

        const showRes = await fetch(`${service.baseUrl}/api/triggers/manual-hello-world`);
        expect(showRes.status).toBe(200);
        const shown = (await showRes.json()) as { id: string };
        expect(shown.id).toBe("manual-hello-world");

        const missingRes = await fetch(`${service.baseUrl}/api/triggers/no-such-trigger`);
        expect(missingRes.status).toBe(404);

        const fireRes = await fetch(
          `${service.baseUrl}/api/triggers/manual-hello-world/fire`,
          { method: "POST" },
        );
        expect(fireRes.status).toBe(202);
        const fired = (await fireRes.json()) as { runId: string };
        expect(typeof fired.runId).toBe("string");

        const run = await store.readRun(fired.runId);
        expect(run.pipeline_id).toBe("hello");

        const trigger = await store.getTrigger("manual-hello-world");
        expect(trigger?.last_run_id).toBe(fired.runId);

        const listAfterFireRes = await fetch(`${service.baseUrl}/api/triggers`);
        const listedAfterFire = (await listAfterFireRes.json()) as {
          triggers: Array<{ id: string; last_run_id?: string }>;
        };
        expect(listedAfterFire.triggers[0]!.last_run_id).toBe(fired.runId);

        const fireMissingRes = await fetch(
          `${service.baseUrl}/api/triggers/no-such-trigger/fire`,
          { method: "POST" },
        );
        expect(fireMissingRes.status).toBe(404);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("POST /api/triggers creates a trigger, validates the body, and rejects bad refs/cron/duplicates", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-http-create-"));
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const invalidJsonRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not json",
        });
        expect(invalidJsonRes.status).toBe(400);

        const badBodyRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            pipeline: "hello",
            task: "my-task",
            kind: "manual",
          }),
        });
        expect(badBodyRes.status).toBe(400);
        const badBody = (await badBodyRes.json()) as { error: string };
        expect(badBody.error).toMatch(/id is required/);

        const danglingRefRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "dangling",
            pipeline: "no-such-pipeline",
            task: "my-task",
            kind: "manual",
          }),
        });
        expect(danglingRefRes.status).toBe(422);
        const danglingRef = (await danglingRefRes.json()) as { error: string };
        expect(danglingRef.error).toMatch(/unknown pipeline/);

        const badCronRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "bad-cron",
            pipeline: "hello",
            task: "my-task",
            kind: "schedule",
            schedule: { cron: "not a cron" },
          }),
        });
        expect(badCronRes.status).toBe(422);
        const badCron = (await badCronRes.json()) as { error: string };
        expect(badCron.error).toMatch(/Invalid schedule.cron/);

        const duplicateRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "manual-hello-world",
            pipeline: "hello",
            task: "my-task",
            kind: "manual",
          }),
        });
        expect(duplicateRes.status).toBe(409);

        const createdRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "nightly-hello",
            pipeline: "hello",
            task: "my-task",
            kind: "schedule",
            schedule: { cron: "0 2 * * *", timezone: "UTC" },
          }),
        });
        expect(createdRes.status).toBe(201);
        const created = (await createdRes.json()) as {
          id: string;
          pipeline: string;
          task: string;
          kind: string;
          enabled: boolean;
        };
        expect(created).toMatchObject({
          id: "nightly-hello",
          pipeline: "hello",
          task: "my-task",
          kind: "schedule",
          enabled: true,
        });

        const listRes = await fetch(`${service.baseUrl}/api/triggers`);
        expect(listRes.status).toBe(200);
        const listed = (await listRes.json()) as { triggers: Array<{ id: string }> };
        expect(listed.triggers.map((t) => t.id)).toContain("nightly-hello");

        const writtenPath = path.join(root, "triggers", "nightly-hello.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("id: nightly-hello");
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("POST /api/triggers/:id/fire on a disabled trigger returns 409 and does not create a run", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "manual-disabled.trigger.yaml"),
        "id: manual-disabled\npipeline: hello\ntask: my-task\nkind: manual\nenabled: false\n",
      );
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-http-disabled-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const fireRes = await fetch(
          `${service.baseUrl}/api/triggers/manual-disabled/fire`,
          { method: "POST" },
        );
        expect(fireRes.status).toBe(409);
        const body = (await fireRes.json()) as { error: string };
        expect(body.error).toMatch(/disabled/i);

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
