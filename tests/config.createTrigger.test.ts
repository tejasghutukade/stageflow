import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTrigger, parseCreateTriggerBody } from "../src/config/createTrigger.js";
import { loadTriggerOutcome } from "../src/config/loadTrigger.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

async function seedCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    [
      "id: hello",
      "stages:",
      "  - id: clarify",
      "    system_prompt: Say hello.",
      "    io:",
      "      input:",
      "        schema:",
      "          type: object",
      "      output:",
      "        schema:",
      "          type: object",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
}

const BASE_BODY = {
  directory: "triggers",
  id: "ok",
  pipeline: "hello",
  task: "my-task",
  kind: "manual",
};

describe("parseCreateTriggerBody", () => {
  it.each([
    { name: "a valid manual body", body: { ...BASE_BODY, id: "nightly-hello" } },
    {
      name: "a manual body with task omitted",
      body: { directory: "triggers", id: "dynamic-hello", pipeline: "hello", kind: "manual" },
    },
    {
      name: "schedule.cron with timezone",
      body: {
        ...BASE_BODY,
        kind: "schedule",
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
      },
    },
    {
      name: "event.source with match",
      body: {
        ...BASE_BODY,
        kind: "event",
        event: { source: "github", match: { type: "issue" } },
      },
    },
    {
      name: "event.config alongside match",
      body: {
        ...BASE_BODY,
        kind: "event",
        event: {
          source: "webhook",
          match: { action: "opened" },
          config: { secretRef: "WEBHOOK_SECRET", header: "x-signature" },
        },
      },
    },
    { name: "a boolean enabled", body: { ...BASE_BODY, enabled: false } },
  ])("passes through $name unchanged", ({ body }) => {
    expect(parseCreateTriggerBody(body)).toEqual(body);
  });

  it.each([
    {
      name: "a non-object body",
      body: null,
      error: "Request body must be an object",
    },
    {
      name: "a bad id format",
      body: { ...BASE_BODY, id: "Bad_Id" },
      error: "id must be lowercase kebab-case",
    },
    {
      name: "an unknown kind",
      body: { ...BASE_BODY, kind: "cron" },
      error: "kind must be one of: manual, schedule, event",
    },
    {
      name: "kind=schedule without schedule.cron",
      body: { ...BASE_BODY, kind: "schedule" },
      error: "schedule.cron is required for kind=schedule",
    },
    {
      name: "kind=event without event.source",
      body: { ...BASE_BODY, kind: "event" },
      error: "event.source is required for kind=event",
    },
    {
      name: "a non-object event.config",
      body: { ...BASE_BODY, kind: "event", event: { source: "webhook", config: "nope" } },
      error: "event.config must be an object",
    },
    {
      name: "a non-boolean enabled",
      body: { ...BASE_BODY, enabled: "yes" },
      error: "enabled must be a boolean",
    },
  ])("rejects $name", ({ body, error }) => {
    expect(parseCreateTriggerBody(body)).toEqual({ ok: false, status: 400, error });
  });
});

async function withCatalog(fn: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  try {
    await seedCatalog(root);
    clearFindProjectRootCacheForTests();
    await fn(root);
  } finally {
    clearFindProjectRootCacheForTests();
    await cleanup();
  }
}

describe("createTrigger", () => {
  it("creates a manual trigger file that round-trips, defaulting enabled to true", () =>
    withCatalog(async (root) => {
      const created = await createTrigger(root, {
        directory: "triggers",
        id: "manual-new",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      });

      expect(created).toEqual({
        ok: true,
        trigger: {
          id: "manual-new",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
          enabled: true,
          definition_ref: "triggers/manual-new.trigger.yaml",
        },
      });

      const filePath = path.join(root, "triggers", "manual-new.trigger.yaml");
      const yaml = await readFile(filePath, "utf8");
      expect(yaml).toContain("id: manual-new");
      expect(yaml).toContain("enabled: true");

      const reloaded = await loadTriggerOutcome(filePath);
      expect(reloaded.ok && reloaded.value).toEqual({
        id: "manual-new",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
        enabled: true,
      });
    }));

  it("creates a schedule trigger honoring an explicit enabled: false", () =>
    withCatalog(async (root) => {
      const created = await createTrigger(root, {
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        task: "my-task",
        kind: "schedule",
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
        enabled: false,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.trigger).toMatchObject({
        id: "nightly",
        kind: "schedule",
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
        enabled: false,
      });
      const reloaded = await loadTriggerOutcome(
        path.join(root, "triggers", "nightly.trigger.yaml"),
      );
      expect(reloaded.ok && reloaded.value.enabled).toBe(false);
    }));

  it("creates a dynamic-mode trigger with task omitted, writing no task key", () =>
    withCatalog(async (root) => {
      const created = await createTrigger(root, {
        directory: "triggers",
        id: "dynamic-hello",
        pipeline: "hello",
        kind: "manual",
      });

      expect(created).toEqual({
        ok: true,
        trigger: {
          id: "dynamic-hello",
          pipeline: "hello",
          kind: "manual",
          enabled: true,
          definition_ref: "triggers/dynamic-hello.trigger.yaml",
        },
      });

      const filePath = path.join(root, "triggers", "dynamic-hello.trigger.yaml");
      expect(await readFile(filePath, "utf8")).not.toContain("task:");

      const reloaded = await loadTriggerOutcome(filePath);
      expect(reloaded.ok && reloaded.value).toEqual({
        id: "dynamic-hello",
        pipeline: "hello",
        kind: "manual",
        enabled: true,
      });
    }));

  it.each([
    {
      id: "on-webhook",
      event: {
        source: "webhook",
        config: { secretRef: "WEBHOOK_SECRET", header: "x-signature" },
      },
    },
    {
      id: "on-email",
      event: {
        source: "email.message",
        config: {
          host: "imap.example.com",
          port: 993,
          user: "notifications@example.com",
          secretRef: "EMAIL_PASSWORD",
        },
      },
    },
  ])("creates an event trigger ($event.source) whose config round-trips through YAML", ({ id, event }) =>
    withCatalog(async (root) => {
      const created = await createTrigger(root, {
        directory: "triggers",
        id,
        pipeline: "hello",
        kind: "event",
        event,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.trigger).toMatchObject({ id, kind: "event", event });

      const reloaded = await loadTriggerOutcome(path.join(root, "triggers", `${id}.trigger.yaml`));
      expect(reloaded.ok && reloaded.value.event).toMatchObject(event);
    }));

  it.each([
    {
      name: "a bad id format",
      body: { id: "Bad_Id" },
      status: 400,
      error: "id must be lowercase kebab-case",
    },
    {
      name: "a directory outside the project root",
      body: { directory: "../outside", id: "manual-outside" },
      status: 400,
      error: "directory must be inside the project root",
    },
    {
      name: "a dangling pipeline ref",
      body: { id: "manual-bad-pipeline", pipeline: "does-not-exist" },
      status: 422,
      error: 'Trigger references unknown pipeline "does-not-exist"',
    },
    {
      name: "a dangling task ref",
      body: { id: "manual-bad-task", task: "also-missing" },
      status: 422,
      error: 'Trigger references unknown task "also-missing"',
    },
  ])("returns $status for $name", ({ body, status, error }) =>
    withCatalog(async (root) => {
      const result = await createTrigger(root, { ...BASE_BODY, ...body });
      expect(result).toEqual({ ok: false, status, error });
    }));

  it("returns 422 for an invalid cron expression on a schedule-kind trigger", () =>
    withCatalog(async (root) => {
      const result = await createTrigger(root, {
        ...BASE_BODY,
        id: "bad-cron",
        kind: "schedule",
        schedule: { cron: "not a cron expression" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.error).toContain("Invalid schedule.cron");
    }));

  it("returns 409 when the id collides with an existing trigger", () =>
    withCatalog(async (root) => {
      await writeFile(
        path.join(root, "triggers", "manual-hello-world.trigger.yaml"),
        "id: manual-hello-world\npipeline: hello\ntask: my-task\nkind: manual\nenabled: true\n",
      );
      const result = await createTrigger(root, { ...BASE_BODY, id: "manual-hello-world" });
      expect(result).toEqual({
        ok: false,
        status: 409,
        error: "Trigger id already exists (triggers/manual-hello-world.trigger.yaml)",
      });
    }));
});
