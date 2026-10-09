import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { startTestService } from "./helpers/testInProcessService.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const triggerFixture = path.join(fixtures, "triggers", "manual-hello-world.trigger.yaml");
const dynamicTriggerFixture = path.join(fixtures, "triggers", "dynamic-hello.trigger.yaml");
const webhookCatalogFixture = path.join(fixtures, "triggers", "webhook-catalog.trigger.yaml");
const webhookDynamicFixture = path.join(fixtures, "triggers", "webhook-dynamic.trigger.yaml");
const webhookNoConfigFixture = path.join(fixtures, "triggers", "webhook-no-config.trigger.yaml");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

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

async function withTriggerService(
  opts: {
    setup?: (root: string) => Promise<void>;
    ensureProject?: boolean;
    agent?: AgentPort;
  },
  fn: (ctx: {
    root: string;
    store: ReturnType<typeof createRunStore>;
    service: Awaited<ReturnType<typeof startTestService>>;
  }) => Promise<void>,
): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  try {
    await seedCatalog(root);
    await opts.setup?.(root);
    clearFindProjectRootCacheForTests();
    const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-http-"));
    const store = createRunStore({ rootDir: homeRoot });
    if (opts.ensureProject) await store.ensureProject(root);
    const service = await startTestService(store, opts.agent ?? scriptedFakeAgent([]), root);
    try {
      await fn({ root, store, service });
    } finally {
      await service.stop();
    }
  } finally {
    clearFindProjectRootCacheForTests();
    await cleanup();
  }
}

describe("trigger HTTP routes", () => {
  it("GET /api/triggers lists the catalog trigger; GET /:id and POST /:id/fire round-trip", async () => {
    await withTriggerService(
      {
        agent: scriptedFakeAgent([successEnvelope("clarified")]),
      },
      async ({ root, store, service }) => {
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
      },
    );
  });

  it("POST /api/triggers/:id/fire either/or task modes: dynamic+task, dynamic+no-task, catalog+task, catalog+no-task, malformed task body", async () => {
    await withTriggerService(
      {
        setup: async (root) => {
            await writeFile(
              path.join(root, "triggers", "dynamic-hello.trigger.yaml"),
              await readFile(dynamicTriggerFixture, "utf8"),
            );
            },
        agent: scriptedFakeAgent([successEnvelope("clarified"), successEnvelope("clarified")]),
      },
      async ({ root, store, service }) => {
        const dynamicFireRes = await fetch(
          `${service.baseUrl}/api/triggers/dynamic-hello/fire`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task: { id: "inline-task", goal: "Say hello dynamically" } }),
          },
        );
        expect(dynamicFireRes.status).toBe(202);
        const dynamicFired = (await dynamicFireRes.json()) as { runId: string };
        const dynamicRun = await store.readRun(dynamicFired.runId);
        expect(dynamicRun.task_id).toBe("inline-task");

        const dynamicNoTaskRes = await fetch(
          `${service.baseUrl}/api/triggers/dynamic-hello/fire`,
          { method: "POST" },
        );
        expect(dynamicNoTaskRes.status).toBe(422);
        const dynamicNoTask = (await dynamicNoTaskRes.json()) as { error: string; code?: string };
        expect(dynamicNoTask.code).toBe("trigger.task_required");

        const catalogWithTaskRes = await fetch(
          `${service.baseUrl}/api/triggers/manual-hello-world/fire`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task: { id: "inline-task", goal: "Say hello dynamically" } }),
          },
        );
        expect(catalogWithTaskRes.status).toBe(422);
        const catalogWithTask = (await catalogWithTaskRes.json()) as {
          error: string;
          code?: string;
        };
        expect(catalogWithTask.code).toBe("trigger.task_override_not_allowed");

        const catalogNoTaskRes = await fetch(
          `${service.baseUrl}/api/triggers/manual-hello-world/fire`,
          { method: "POST" },
        );
        expect(catalogNoTaskRes.status).toBe(202);
        const catalogFired = (await catalogNoTaskRes.json()) as { runId: string };
        const catalogRun = await store.readRun(catalogFired.runId);
        expect(catalogRun.task_id).toBe("my-task");

        const malformedTaskRes = await fetch(
          `${service.baseUrl}/api/triggers/dynamic-hello/fire`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task: { goal: "missing id" } }),
          },
        );
        expect(malformedTaskRes.status).toBe(400);
        const malformedTask = (await malformedTaskRes.json()) as { error: string };
        expect(malformedTask.error).toMatch(/id and goal are required strings/);
      },
    );
  });

  it("POST /api/triggers creates a trigger, validates the body, and rejects bad refs/cron/duplicates", async () => {
    await withTriggerService(
      {
        ensureProject: true,
        agent: scriptedFakeAgent([]),
      },
      async ({ root, store, service }) => {
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

        const createdDynamicRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "dynamic-created",
            pipeline: "hello",
            kind: "manual",
          }),
        });
        expect(createdDynamicRes.status).toBe(201);
        const createdDynamic = (await createdDynamicRes.json()) as {
          id: string;
          task?: string;
        };
        expect(createdDynamic.id).toBe("dynamic-created");
        expect(createdDynamic.task).toBeUndefined();

        const dynamicWrittenPath = path.join(root, "triggers", "dynamic-created.trigger.yaml");
        const dynamicWritten = await readFile(dynamicWrittenPath, "utf8");
        expect(dynamicWritten).not.toContain("task:");

        const listAfterDynamicRes = await fetch(`${service.baseUrl}/api/triggers`);
        expect(listAfterDynamicRes.status).toBe(200);
        const listedAfterDynamic = (await listAfterDynamicRes.json()) as {
          triggers: Array<{ id: string; task?: string }>;
        };
        const dynamicListed = listedAfterDynamic.triggers.find(
          (t) => t.id === "dynamic-created",
        );
        expect(dynamicListed).toBeDefined();
        expect(dynamicListed?.task).toBeUndefined();
      },
    );
  });

  it("POST /api/triggers/:id/fire on a disabled trigger returns 409 and does not create a run", async () => {
    await withTriggerService(
      {
        setup: async (root) => {
            await writeFile(
              path.join(root, "triggers", "manual-disabled.trigger.yaml"),
              "id: manual-disabled\npipeline: hello\ntask: my-task\nkind: manual\nenabled: false\n",
            );
            },
        agent: scriptedFakeAgent([]),
      },
      async ({ root, store, service }) => {
        const fireRes = await fetch(
          `${service.baseUrl}/api/triggers/manual-disabled/fire`,
          { method: "POST" },
        );
        expect(fireRes.status).toBe(409);
        const body = (await fireRes.json()) as { error: string };
        expect(body.error).toMatch(/disabled/i);

        expect(await store.getTrigger("manual-disabled")).toBeNull();
        expect((await store.listRuns()).length).toBe(0);
      },
    );
  });

  it("POST /api/triggers creates a webhook-configured event trigger that fires end to end via POST /:id/webhook", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const secret = "created-webhook-secret-please-ignore";
    const priorSecret = process.env.CREATED_WEBHOOK_SECRET;
    process.env.CREATED_WEBHOOK_SECRET = secret;
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-http-create-webhook-"));
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const createdRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "on-webhook",
            pipeline: "hello",
            task: "my-task",
            kind: "event",
            event: {
              source: "webhook",
              config: { secretRef: "CREATED_WEBHOOK_SECRET", header: "x-signature" },
            },
          }),
        });
        expect(createdRes.status).toBe(201);
        const created = (await createdRes.json()) as {
          id: string;
          event?: { source: string; config?: Record<string, unknown> };
        };
        expect(created.event).toEqual({
          source: "webhook",
          config: { secretRef: "CREATED_WEBHOOK_SECRET", header: "x-signature" },
        });

        const writtenPath = path.join(root, "triggers", "on-webhook.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("secretRef: CREATED_WEBHOOK_SECRET");
        expect(written).toContain("header: x-signature");

        const body = JSON.stringify({ action: "opened", number: 1 });
        const runsBefore = (await store.listRuns()).length;
        const fireRes = await fetch(`${service.baseUrl}/api/triggers/on-webhook/webhook`, {
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
        expect(run.task_id).toBe("my-task");
        expect((await store.listRuns()).length).toBe(runsBefore + 1);

        const wrongSigRes = await fetch(`${service.baseUrl}/api/triggers/on-webhook/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-signature": sign("wrong-secret", body),
          },
          body,
        });
        expect(wrongSigRes.status).toBe(401);
      } finally {
        await service.stop();
      }
    } finally {
      if (priorSecret === undefined) delete process.env.CREATED_WEBHOOK_SECRET;
      else process.env.CREATED_WEBHOOK_SECRET = priorSecret;
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("POST /api/triggers creates an email-configured event trigger with a numeric port that round-trips via GET", async () => {
    await withTriggerService(
      {
        ensureProject: true,
        agent: scriptedFakeAgent([successEnvelope("clarified")]),
      },
      async ({ root, store, service }) => {
        const createdRes = await fetch(`${service.baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "triggers",
            id: "on-email",
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
          }),
        });
        expect(createdRes.status).toBe(201);
        const created = (await createdRes.json()) as {
          id: string;
          event?: { source: string; config?: Record<string, unknown> };
        };
        expect(created.event).toEqual({
          source: "email.message",
          config: {
            host: "imap.example.com",
            port: 993,
            user: "notifications@example.com",
            secretRef: "EMAIL_PASSWORD",
          },
        });

        const writtenPath = path.join(root, "triggers", "on-email.trigger.yaml");
        const written = await readFile(writtenPath, "utf8");
        expect(written).toContain("port: 993");
        expect(written).toContain("secretRef: EMAIL_PASSWORD");

        const getRes = await fetch(`${service.baseUrl}/api/triggers/on-email`);
        expect(getRes.status).toBe(200);
        const fetched = (await getRes.json()) as {
          event?: { source: string; config?: Record<string, unknown> };
        };
        expect(fetched.event).toEqual({
          source: "email.message",
          config: {
            host: "imap.example.com",
            port: 993,
            user: "notifications@example.com",
            secretRef: "EMAIL_PASSWORD",
          },
        });
        expect(typeof fetched.event?.config?.port).toBe("number");
      },
    );
  });

  it("POST /api/triggers/:id/webhook verifies signature, evaluates match, and fires either/or", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const secret = "webhook-test-secret-please-ignore";
    const priorSecret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = secret;
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "webhook-catalog.trigger.yaml"),
        await readFile(webhookCatalogFixture, "utf8"),
      );
      await writeFile(
        path.join(root, "triggers", "webhook-dynamic.trigger.yaml"),
        await readFile(webhookDynamicFixture, "utf8"),
      );
      await writeFile(
        path.join(root, "triggers", "webhook-no-config.trigger.yaml"),
        await readFile(webhookNoConfigFixture, "utf8"),
      );
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-webhook-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([
        successEnvelope("clarified"),
        successEnvelope("clarified"),
      ]);
      const service = await startTestService(store, agent, root);
      try {
        // Unknown trigger id -> 404.
        const unknownRes = await fetch(`${service.baseUrl}/api/triggers/no-such-trigger/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": "irrelevant" },
          body: "{}",
        });
        expect(unknownRes.status).toBe(404);

        // No event.config -> 400 immediately, no signature check attempted.
        const noConfigRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-no-config/webhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        expect(noConfigRes.status).toBe(400);
        const noConfigBody = (await noConfigRes.json()) as { error: string };
        expect(noConfigBody.error).toMatch(/no webhook signing configured/);

        // Valid signed request, catalog-mode trigger -> fires a real run.
        const catalogBody = JSON.stringify({ action: "opened", number: 7 });
        const catalogRunsBefore = (await store.listRuns()).length;
        const catalogRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-catalog/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-signature": sign(secret, catalogBody),
            },
            body: catalogBody,
          },
        );
        expect(catalogRes.status).toBe(201);
        const catalogFired = (await catalogRes.json()) as { fired: boolean; runId: string };
        expect(catalogFired.fired).toBe(true);
        expect(typeof catalogFired.runId).toBe("string");
        const catalogRun = await store.readRun(catalogFired.runId);
        expect(catalogRun.pipeline_id).toBe("hello");
        expect(catalogRun.task_id).toBe("my-task");
        expect((await store.listRuns()).length).toBe(catalogRunsBefore + 1);

        // Wrong signature -> 401, no run created.
        const wrongSigRunsBefore = (await store.listRuns()).length;
        const wrongSigRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-catalog/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-signature": sign("not-the-right-secret", catalogBody),
            },
            body: catalogBody,
          },
        );
        expect(wrongSigRes.status).toBe(401);
        expect((await store.listRuns()).length).toBe(wrongSigRunsBefore);

        // Malformed JSON, even signed against those exact bytes -> 400 (after signature check).
        const malformedBody = "{not valid json";
        const malformedRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-catalog/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-signature": sign(secret, malformedBody),
            },
            body: malformedBody,
          },
        );
        expect(malformedRes.status).toBe(400);

        // Valid signature, event.match doesn't match the payload -> 200 { fired: false }, no run.
        const unmatchedBody = JSON.stringify({ action: "closed", number: 9 });
        const unmatchedRunsBefore = (await store.listRuns()).length;
        const unmatchedRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-dynamic/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-signature": sign(secret, unmatchedBody),
            },
            body: unmatchedBody,
          },
        );
        expect(unmatchedRes.status).toBe(200);
        const unmatched = (await unmatchedRes.json()) as { fired: boolean };
        expect(unmatched.fired).toBe(false);
        expect((await store.listRuns()).length).toBe(unmatchedRunsBefore);

        // Valid signature, matching payload, dynamic-mode trigger -> fires with payload as task input.
        const matchedBody = JSON.stringify({ action: "opened", number: 11 });
        const matchedRes = await fetch(
          `${service.baseUrl}/api/triggers/webhook-dynamic/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-signature": sign(secret, matchedBody),
            },
            body: matchedBody,
          },
        );
        expect(matchedRes.status).toBe(201);
        const matchedFired = (await matchedRes.json()) as { fired: boolean; runId: string };
        expect(matchedFired.fired).toBe(true);
        const matchedRun = await store.readRun(matchedFired.runId);
        expect(matchedRun.pipeline_id).toBe("hello");
        expect(matchedRun.task_id).toMatch(/^webhook-dynamic-webhook-/);
        const matchedTask = await store.readTaskYaml(matchedFired.runId);
        expect(matchedTask).toContain("number: 11");
        expect(matchedTask).toContain("action: opened");
      } finally {
        await service.stop();
      }
    } finally {
      if (priorSecret === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = priorSecret;
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
