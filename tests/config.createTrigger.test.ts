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

describe("parseCreateTriggerBody", () => {
  it("accepts a valid manual body", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "nightly-hello",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      }),
    ).toEqual({
      directory: "triggers",
      id: "nightly-hello",
      pipeline: "hello",
      task: "my-task",
      kind: "manual",
    });
  });

  it("accepts a valid manual body with task omitted", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "dynamic-hello",
        pipeline: "hello",
        kind: "manual",
      }),
    ).toEqual({
      directory: "triggers",
      id: "dynamic-hello",
      pipeline: "hello",
      kind: "manual",
    });
  });

  it("rejects a non-object body", () => {
    expect(parseCreateTriggerBody(null)).toEqual({
      ok: false,
      status: 400,
      error: "Request body must be an object",
    });
  });

  it("rejects a bad id format", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "Bad_Id",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      }),
    ).toEqual({ ok: false, status: 400, error: "id must be lowercase kebab-case" });
  });

  it("rejects an unknown kind", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "ok",
        pipeline: "hello",
        task: "my-task",
        kind: "cron",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "kind must be one of: manual, schedule, event",
    });
  });

  it("requires schedule.cron for kind=schedule", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        task: "my-task",
        kind: "schedule",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "schedule.cron is required for kind=schedule",
    });

    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        task: "my-task",
        kind: "schedule",
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
      }),
    ).toEqual({
      directory: "triggers",
      id: "nightly",
      pipeline: "hello",
      task: "my-task",
      kind: "schedule",
      schedule: { cron: "0 2 * * *", timezone: "UTC" },
    });
  });

  it("requires event.source for kind=event", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "on-issue",
        pipeline: "hello",
        task: "my-task",
        kind: "event",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "event.source is required for kind=event",
    });

    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "on-issue",
        pipeline: "hello",
        task: "my-task",
        kind: "event",
        event: { source: "github", match: { type: "issue" } },
      }),
    ).toEqual({
      directory: "triggers",
      id: "on-issue",
      pipeline: "hello",
      task: "my-task",
      kind: "event",
      event: { source: "github", match: { type: "issue" } },
    });
  });

  it("passes through enabled when a boolean, rejects otherwise", () => {
    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "ok",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });

    expect(
      parseCreateTriggerBody({
        directory: "triggers",
        id: "ok",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
        enabled: "yes",
      }),
    ).toEqual({ ok: false, status: 400, error: "enabled must be a boolean" });
  });
});

describe("createTrigger", () => {
  it("creates a manual trigger file that round-trips, defaulting enabled to true", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

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
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value).toEqual({
          id: "manual-new",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
          enabled: true,
        });
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("creates a schedule trigger honoring an explicit enabled: false", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

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
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 400 for a bad id format", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "Bad_Id",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "id must be lowercase kebab-case",
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 400 when directory resolves outside the project root", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "../outside",
        id: "manual-outside",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "directory must be inside the project root",
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 422 for a dangling pipeline ref", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "manual-bad-pipeline",
        pipeline: "does-not-exist",
        task: "my-task",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 422,
        error: 'Trigger references unknown pipeline "does-not-exist"',
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 422 for a dangling task ref", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "manual-bad-task",
        pipeline: "hello",
        task: "also-missing",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 422,
        error: 'Trigger references unknown task "also-missing"',
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 422 for an invalid cron expression on a schedule-kind trigger", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "bad-cron",
        pipeline: "hello",
        task: "my-task",
        kind: "schedule",
        schedule: { cron: "not a cron expression" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(result.error).toContain("Invalid schedule.cron");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("creates a dynamic-mode trigger with task omitted, writing no task key", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

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
      const yaml = await readFile(filePath, "utf8");
      expect(yaml).not.toContain("task:");

      const reloaded = await loadTriggerOutcome(filePath);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value).toEqual({
          id: "dynamic-hello",
          pipeline: "hello",
          kind: "manual",
          enabled: true,
        });
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("still rejects a dangling pipeline ref when task is omitted", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "dynamic-bad-pipeline",
        pipeline: "does-not-exist",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 422,
        error: 'Trigger references unknown pipeline "does-not-exist"',
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns 409 when the id collides with an existing trigger", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "manual-hello-world.trigger.yaml"),
        "id: manual-hello-world\npipeline: hello\ntask: my-task\nkind: manual\nenabled: true\n",
      );
      clearFindProjectRootCacheForTests();

      const result = await createTrigger(root, {
        directory: "triggers",
        id: "manual-hello-world",
        pipeline: "hello",
        task: "my-task",
        kind: "manual",
      });
      expect(result).toEqual({
        ok: false,
        status: 409,
        error: "Trigger id already exists (triggers/manual-hello-world.trigger.yaml)",
      });
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
