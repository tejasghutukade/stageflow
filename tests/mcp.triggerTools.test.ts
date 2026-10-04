import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
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
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
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

  it("fire_trigger either/or task modes: dynamic+task succeeds, dynamic+no-task rejected, catalog+task rejected, catalog+no-task unchanged", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "dynamic-hello.trigger.yaml"),
        await readFile(dynamicTriggerFixture, "utf8"),
      );
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-dynamic-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified"), successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const dynamicFired = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "dynamic-hello",
          task: { id: "inline-task", goal: "Say hello dynamically" },
        });
        expect(dynamicFired.isError).toBe(false);
        const dynamicRun = await store.readRun(dynamicFired.payload.runId);
        expect(dynamicRun.task_id).toBe("inline-task");

        const dynamicNoTask = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "dynamic-hello",
        });
        expect(dynamicNoTask.isError).toBe(true);
        expect(dynamicNoTask.payload.status).toBe(422);
        expect(dynamicNoTask.payload.code).toBe("trigger.task_required");

        const catalogWithTask = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "manual-hello-world",
          task: { id: "inline-task", goal: "Say hello dynamically" },
        });
        expect(catalogWithTask.isError).toBe(true);
        expect(catalogWithTask.payload.status).toBe(422);
        expect(catalogWithTask.payload.code).toBe("trigger.task_override_not_allowed");

        const catalogNoTask = await mcpCall(service.baseUrl, "fire_trigger", {
          id: "manual-hello-world",
        });
        expect(catalogNoTask.isError).toBe(false);
        const catalogRun = await store.readRun(catalogNoTask.payload.runId);
        expect(catalogRun.task_id).toBe("my-task");
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

        const createdDynamic = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "dynamic-created",
          pipeline: "hello",
          kind: "manual",
        });
        expect(createdDynamic.isError).toBe(false);
        expect(createdDynamic.payload).toMatchObject({
          id: "dynamic-created",
          pipeline: "hello",
          kind: "manual",
          enabled: true,
        });
        expect(createdDynamic.payload.task).toBeUndefined();

        const dynamicWrittenPath = path.join(root, "triggers", "dynamic-created.trigger.yaml");
        const dynamicWritten = await readFile(dynamicWrittenPath, "utf8");
        expect(dynamicWritten).not.toContain("task:");
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("create_trigger passes through event.config; the created trigger fires end to end via POST /:id/webhook", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const secret = "mcp-created-webhook-secret-please-ignore";
    const priorSecret = process.env.MCP_CREATED_WEBHOOK_SECRET;
    process.env.MCP_CREATED_WEBHOOK_SECRET = secret;
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-create-webhook-"));
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const created = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "mcp-on-webhook",
          pipeline: "hello",
          task: "my-task",
          kind: "event",
          event: {
            source: "webhook",
            config: { secretRef: "MCP_CREATED_WEBHOOK_SECRET", header: "x-signature" },
          },
        });
        expect(created.isError).toBe(false);
        expect(created.payload.event).toEqual({
          source: "webhook",
          config: { secretRef: "MCP_CREATED_WEBHOOK_SECRET", header: "x-signature" },
        });

        const writtenPath = path.join(root, "triggers", "mcp-on-webhook.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("secretRef: MCP_CREATED_WEBHOOK_SECRET");

        const body = JSON.stringify({ action: "opened", number: 1 });
        const fireRes = await fetch(`${service.baseUrl}/api/triggers/mcp-on-webhook/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-signature": sign(secret, body),
          },
          body,
        });
        expect(fireRes.status).toBe(201);
        const fired = (await fireRes.json()) as { fired: boolean; runId: string };
        expect(fired.fired).toBe(true);
        const run = await store.readRun(fired.runId);
        expect(run.pipeline_id).toBe("hello");
      } finally {
        await service.stop();
      }
    } finally {
      if (priorSecret === undefined) delete process.env.MCP_CREATED_WEBHOOK_SECRET;
      else process.env.MCP_CREATED_WEBHOOK_SECRET = priorSecret;
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("create_trigger passes through email event.config (numeric port); get_trigger shows it intact", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-trigger-create-email-"));
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const created = await mcpCall(service.baseUrl, "create_trigger", {
          directory: "triggers",
          id: "mcp-on-email",
          pipeline: "hello",
          task: "my-task",
          kind: "event",
          event: {
            source: "email.message",
            config: {
              host: "imap.example.com",
              port: 993,
              user: "notifications@example.com",
              secretRef: "EMAIL_PASSWORD",
            },
          },
        });
        expect(created.isError).toBe(false);
        expect(created.payload.event).toEqual({
          source: "email.message",
          config: {
            host: "imap.example.com",
            port: 993,
            user: "notifications@example.com",
            secretRef: "EMAIL_PASSWORD",
          },
        });

        const writtenPath = path.join(root, "triggers", "mcp-on-email.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("port: 993");
        expect(written).toContain("secretRef: EMAIL_PASSWORD");

        const fetched = await mcpCall(service.baseUrl, "get_trigger", { id: "mcp-on-email" });
        expect(fetched.isError).toBe(false);
        expect(fetched.payload.event).toEqual({
          source: "email.message",
          config: {
            host: "imap.example.com",
            port: 993,
            user: "notifications@example.com",
            secretRef: "EMAIL_PASSWORD",
          },
        });
        expect(typeof fetched.payload.event.config.port).toBe("number");
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
