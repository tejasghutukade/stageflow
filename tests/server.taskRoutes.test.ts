import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { workspaceCatalogPath } from "../src/project/workspaceCatalog.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";
import { startTestService } from "./helpers/testInProcessService.js";

async function seedCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n",
  );
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    ["id: my-task", "# operator note", "goal: Say hello", "context: keep this", ""].join("\n"),
  );
}

async function withTaskService(
  fn: (ctx: {
    root: string;
    rootWire: string;
    baseUrl: string;
  }) => Promise<void>,
): Promise<void> {
  await withIsolatedHome(async () => {
    const { root, cleanup } = await initTempGitRepo();
    const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-task-http-"));
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const rootWire = await realpath(root);
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        await fn({ root, rootWire, baseUrl: service.baseUrl });
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
}

describe("task HTTP routes", () => {
  it("POST /api/tasks without project_root writes to workspace catalog", () =>
    withTaskService(async ({ root, rootWire, baseUrl }) => {
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: "tasks",
          id: "fresh-task",
          goal: "Ship it",
          context: "notes",
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as {
        task: { id: string; goal: string; context?: string; path: string; project_root?: string };
      };
      expect(createdBody.task).toMatchObject({
        id: "fresh-task",
        goal: "Ship it",
        context: "notes",
        path: "tasks/fresh-task.task.yaml",
      });
      const workspaceRoot = workspaceCatalogPath();
      const onDisk = await readFile(
        path.join(workspaceRoot, "tasks/fresh-task.task.yaml"),
        "utf8",
      );
      expect(onDisk).toContain("goal: Ship it");
      await expect(
        access(path.join(root, "tasks/fresh-task.task.yaml")),
      ).rejects.toThrow();

      const detail = await fetch(`${baseUrl}/api/tasks/fresh-task`);
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { task: { id: string; goal: string } };
      expect(detailBody.task).toMatchObject({
        id: "fresh-task",
        goal: "Ship it",
        path: "tasks/fresh-task.task.yaml",
      });

      const registeredDetail = await fetch(
        `${baseUrl}/api/tasks/my-task?project_root=${encodeURIComponent(rootWire)}`,
      );
      expect(registeredDetail.status).toBe(200);
      const registeredBody = (await registeredDetail.json()) as {
        task: { id: string; project_root: string };
      };
      expect(registeredBody.task).toMatchObject({
        id: "my-task",
        project_root: rootWire,
      });

      const list = await fetch(`${baseUrl}/api/tasks`);
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { tasks: Array<{ id: string }> };
      expect(listed.tasks.map((task) => task.id)).toContain("fresh-task");
      expect(listed.tasks.map((task) => task.id)).toContain("my-task");
    }));

  it("POST /api/tasks rejects an invalid id", () =>
    withTaskService(async ({ root, baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: "tasks", id: "Bad_Id", goal: "Ship it" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("id must be lowercase kebab-case");
      await expect(access(path.join(root, "tasks/Bad_Id.task.yaml"))).rejects.toThrow();
    }));

  it("PUT /api/tasks/:id changes the goal and keeps the rest of the file", () =>
    withTaskService(async ({ root, rootWire, baseUrl }) => {
      const res = await fetch(
        `${baseUrl}/api/tasks/my-task?project_root=${encodeURIComponent(rootWire)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: "elsewhere",
            id: "other-id",
            goal: "A new goal",
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        task: { id: string; goal: string; context?: string; path: string; project_root: string };
      };
      expect(body.task).toMatchObject({
        id: "my-task",
        goal: "A new goal",
        context: "keep this",
        path: "tasks/my-task.task.yaml",
        project_root: rootWire,
      });
      const onDisk = await readFile(path.join(root, "tasks/my-task.task.yaml"), "utf8");
      expect(onDisk).toContain("# operator note");
      expect(onDisk).toContain("goal: A new goal");
      expect(onDisk).not.toContain("other-id");

      const detail = await fetch(
        `${baseUrl}/api/tasks/my-task?project_root=${encodeURIComponent(rootWire)}`,
      );
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { task: { goal: string } };
      expect(detailBody.task.goal).toBe("A new goal");
    }));

  it("GET /api/tasks/:id returns 409 when task id is ambiguous", async () => {
    await withIsolatedHome(async () => {
      const { root, cleanup } = await initTempGitRepo();
      const { root: otherRoot, cleanup: cleanupOther } = await initTempGitRepo();
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-task-ambig-store-"));
      const ambigId = "ambig-shared-task";
      try {
        await seedCatalog(root);
        await seedCatalog(otherRoot);
        for (const repo of [root, otherRoot]) {
          await writeFile(
            path.join(repo, "tasks", `${ambigId}.task.yaml`),
            `id: ${ambigId}\ngoal: duplicated\n`,
          );
        }
        clearFindProjectRootCacheForTests();
        const store = createRunStore({ rootDir: storeRoot });
        await store.ensureProject(root);
        await store.ensureProject(otherRoot);
        const service = await startTestService(store, scriptedFakeAgent([]), root);
        try {
          const res = await fetch(`${service.baseUrl}/api/tasks/${ambigId}`);
          expect(res.status).toBe(409);
          const body = (await res.json()) as {
            code: string;
            project_roots: string[];
          };
          expect(body.code).toBe("ambiguous_task");
          expect(body.project_roots).toHaveLength(2);
        } finally {
          await service.stop();
        }
      } finally {
        clearFindProjectRootCacheForTests();
        await cleanup();
        await cleanupOther();
        await rm(storeRoot, { recursive: true, force: true });
      }
    });
  });

  it("POST /api/tasks/import rejects a bad repo", () =>
    withTaskService(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/tasks/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "not a repo", number: 1, directory: "tasks" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("repo must be a GitHub owner/repo");
    }));
});
