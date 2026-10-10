import { describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTask, parseCreateTaskBody } from "../src/config/createTask.js";
import {
  importTaskFromIssue,
  parseImportTaskBody,
  type IssueFetch,
} from "../src/config/importTask.js";
import { updateTask } from "../src/config/updateTask.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { withEnv } from "./helpers/withEnv.js";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseCreateTaskBody", () => {
  it("rejects an id that is not lowercase kebab-case", () => {
    expect(
      parseCreateTaskBody({ directory: "tasks", id: "Bad_Id", goal: "Ship it" }),
    ).toEqual({ ok: false, status: 400, error: "id must be lowercase kebab-case" });
  });
});

describe("parseImportTaskBody", () => {
  it("rejects a bad repo without calling the network", () => {
    expect(
      parseImportTaskBody({ repo: "not a repo", number: 12, directory: "tasks" }),
    ).toEqual({ ok: false, status: 400, error: "repo must be a GitHub owner/repo" });
    expect(
      parseImportTaskBody({ repo: "https://github.com/acme/api", number: 12, directory: "tasks" }),
    ).toEqual({ ok: false, status: 400, error: "repo must be a GitHub owner/repo" });
  });
});

describe("createTask", () => {
  it("writes a task file and removes it when the loader rejects the binding", () =>
    withCatalog(async (root) => {
      const created = await createTask(root, {
        directory: "tasks",
        id: "fresh-task",
        goal: "Ship it",
        context: "notes",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.task).toMatchObject({
        id: "fresh-task",
        goal: "Ship it",
        context: "notes",
        path: "tasks/fresh-task.task.yaml",
      });
      const onDisk = await readFile(path.join(root, "tasks/fresh-task.task.yaml"), "utf8");
      expect(onDisk).toContain("id: fresh-task");
      expect(onDisk).toContain("goal: Ship it");

      const invalid = await createTask(root, {
        directory: "tasks",
        id: "bound-both",
        goal: "Ship it",
        checkout: "/tmp/checkout",
        repository: "acme/api",
        ref: "main",
      });
      expect(invalid).toMatchObject({ ok: false, status: 400 });
      if (invalid.ok) return;
      expect(invalid.error).toMatch(/both repository and checkout/);
      await expect(access(path.join(root, "tasks/bound-both.task.yaml"))).rejects.toThrow();
    }));
});

describe("updateTask", () => {
  it("changes goal, keeps comments, and restores the file when the binding is invalid", () =>
    withCatalog(async (root) => {
      const updated = await updateTask(root, "my-task", {
        goal: "A new goal",
        optional: {},
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.task.goal).toBe("A new goal");
      expect(updated.task.context).toBe("keep this");
      expect(updated.task.id).toBe("my-task");
      const onDisk = await readFile(path.join(root, "tasks/my-task.task.yaml"), "utf8");
      expect(onDisk).toContain("# operator note");
      expect(onDisk).toContain("goal: A new goal");

      const invalid = await updateTask(root, "my-task", {
        goal: "A new goal",
        optional: { checkout: "local", repository: "acme/api", ref: "main" },
      });
      expect(invalid).toMatchObject({ ok: false, status: 400 });
      const restored = await readFile(path.join(root, "tasks/my-task.task.yaml"), "utf8");
      expect(restored).toContain("# operator note");
      expect(restored).not.toContain("repository:");
    }));
});

describe("importTaskFromIssue", () => {
  it("does not call fetch for a bad repo or a directory outside the project", async () => {
    const fetchImpl = vi.fn<IssueFetch>();
    const badRepo = await importTaskFromIssue(
      "/tmp/stageflow-task-import",
      { repo: "not a repo", number: 1, directory: "tasks" },
      fetchImpl,
    );
    expect(badRepo).toEqual({
      ok: false,
      status: 400,
      error: "repo must be a GitHub owner/repo",
    });
    const escaped = await importTaskFromIssue(
      "/tmp/stageflow-task-import",
      { repo: "acme/api", number: 1, directory: "../outside" },
      fetchImpl,
    );
    expect(escaped).toMatchObject({
      ok: false,
      status: 400,
      error: "directory must be inside the project root",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes a task from a GitHub issue and suffixes the id on collision", () =>
    withCatalog(async (root) => {
      await createTask(root, {
        directory: "tasks",
        id: "fix-login",
        goal: "Existing",
      });
      const fetchImpl = vi.fn<IssueFetch>(async (url, init) => {
        expect(url).toBe("https://api.github.com/repos/acme/api/issues/12");
        expect(init.headers.Accept).toBe("application/vnd.github+json");
        expect(init.headers["User-Agent"]).toBe("stageflow");
        expect(init.headers.Authorization).toBeUndefined();
        return jsonResponse(200, {
          title: "Fix login",
          body: "Line one\nLine two",
        });
      });
      const imported = await withEnv({ GITHUB_TOKEN: undefined }, () =>
        importTaskFromIssue(
          root,
          { repo: "acme/api", number: 12, directory: "tasks" },
          fetchImpl,
        ),
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(imported.task).toMatchObject({
        id: "fix-login-2",
        goal: "Fix login",
        context: "Line one\nLine two",
        path: "tasks/fix-login-2.task.yaml",
      });
      expect(imported.task.constraints).toBeUndefined();
      const onDisk = await readFile(path.join(root, imported.task.path), "utf8");
      expect(onDisk).not.toMatch(/^constraints:/m);
    }));

  it("maps a GitHub 404 and sends the token only as a bearer header", () =>
    withCatalog(async (root) => {
      const fetchImpl = vi.fn<IssueFetch>(async () => jsonResponse(404, { message: "Not Found" }));
      const missing = await withEnv({ GITHUB_TOKEN: "secret-token" }, () =>
        importTaskFromIssue(root, { repo: "acme/api", number: 9, directory: "tasks" }, fetchImpl),
      );
      expect(missing).toEqual({
        ok: false,
        status: 404,
        error: "GitHub issue not found: acme/api#9",
      });
      expect(missing.ok ? "" : missing.error).not.toContain("secret-token");
      expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer secret-token");
      await expect(access(path.join(root, "tasks/issue-9.task.yaml"))).rejects.toThrow();
    }));

  it("falls back when the title does not slug to a task id", () =>
    withCatalog(async (root) => {
      const fetchImpl = vi.fn<IssueFetch>(async () =>
        jsonResponse(200, { title: "!!!", body: null }),
      );
      const imported = await importTaskFromIssue(
        root,
        { repo: "acme/api", number: 4, directory: "tasks" },
        fetchImpl,
      );
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(imported.task.id).toBe("issue-4");
      expect(imported.task.context).toBeUndefined();
    }));
});
