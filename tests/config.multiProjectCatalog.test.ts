import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPipelinesMultiProject } from "../src/config/multiProjectCatalog.js";
import { resolveCatalogRoots } from "../src/config/resolveCatalogRoots.js";
import { createRunStore } from "../src/runstore/createStore.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeMinimalCatalog(root: string, pipelineId = "hello"): void {
  mkdirSync(path.join(root, "pipelines"), { recursive: true });
  writeFileSync(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "pipelines", `${pipelineId}.pipeline.yaml`),
    `id: ${pipelineId}\nstages:\n  - id: step\n    system_prompt: ok\n    model: cursor/auto\n    io:\n      input:\n        schema:\n          type: object\n      output:\n        schema:\n          type: object\n`,
    "utf8",
  );
}

describe("resolveCatalogRoots + multiProjectCatalog", () => {
  it("cold Host has no boot root (seeded ∪ registered only)", async () => {
    const home = tempDir("sf-cat-home-");
    const boot = tempDir("sf-cat-boot-");
    const store = createRunStore({ rootDir: home });
    const roots = await resolveCatalogRoots({
      store,
      bootCwd: boot,
      seededRoots: [],
    });
    expect(roots.some((r) => (r.kind as string) === "boot")).toBe(false);
    expect(roots).toEqual([]);
  });

  it("unknown project_root filter returns coded error", async () => {
    const home = tempDir("sf-cat-unk-");
    const boot = tempDir("sf-cat-boot2-");
    const store = createRunStore({ rootDir: home });
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      projectRootFilter: "/no/such/root",
      seededRoots: [],
    });
    expect(result.items).toEqual([]);
    expect(result.root_errors[0]?.code).toBe("unknown_project_root");
  });

  it("ensureProject surfaces as registered root without runs", async () => {
    const home = tempDir("sf-cat-ensure-");
    const boot = tempDir("sf-cat-boot-ensure-");
    const project = tempDir("sf-cat-proj-");
    writeFileSync(
      path.join(project, "stageflow.yaml"),
      "version: 1\ncatalog:\n  pipelines: []\n  tasks: []\n",
      "utf8",
    );
    const store = createRunStore({ rootDir: home });
    const normalized = await store.ensureProject(project);
    const roots = await resolveCatalogRoots({
      store,
      bootCwd: boot,
      seededRoots: [],
    });
    expect(roots.some((r) => (r.kind as string) === "boot")).toBe(false);
    const registered = roots.filter((r) => r.kind === "registered");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.project_root).toBe(normalized);
    expect(registered[0]?.path).toBe(normalized);
    expect(registered[0]?.read_only).toBe(false);
  });

  it("idempotent ensureProject does not duplicate roots", async () => {
    const home = tempDir("sf-cat-ensure-idemp-");
    const boot = tempDir("sf-cat-boot-idemp-");
    const project = tempDir("sf-cat-proj-idemp-");
    const store = createRunStore({ rootDir: home });
    const first = await store.ensureProject(project);
    const second = await store.ensureProject(path.join(project, "."));
    expect(second).toBe(first);
    const listed = await store.listRegisteredProjects();
    expect(listed.filter((p) => p === first)).toHaveLength(1);
    const roots = await resolveCatalogRoots({
      store,
      bootCwd: boot,
      seededRoots: [],
    });
    expect(roots.filter((r) => r.kind === "registered")).toHaveLength(1);
  });

  it("vanished root yields catalog_root_unreadable and continues", async () => {
    const home = tempDir("sf-cat-vanish-");
    const boot = tempDir("sf-cat-boot3-");
    const vanished = path.join(home, "gone");
    mkdirSync(vanished);
    const store = createRunStore({ rootDir: home });
    await store.ensureProject(vanished);
    rmSync(vanished, { recursive: true, force: true });
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
    });
    expect(
      result.root_errors.some((e) => e.code === "catalog_root_unreadable"),
    ).toBe(true);
  });

  it("after ensure, registered root lists without matching boot cwd", async () => {
    const home = tempDir("sf-cat-reg-list-");
    const boot = tempDir("sf-cat-boot-reg-");
    const project = tempDir("sf-cat-proj-reg-");
    writeFileSync(
      path.join(project, "stageflow.yaml"),
      "version: 1\ncatalog:\n  pipelines: []\n  tasks: []\n",
      "utf8",
    );
    const store = createRunStore({ rootDir: home });
    const normalized = await store.ensureProject(project);
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
      projectRootFilter: normalized,
    });
    expect(result.roots.some((r) => (r.kind as string) === "boot")).toBe(false);
    expect(result.roots.some((r) => r.kind === "registered" && r.path === normalized)).toBe(
      true,
    );
    expect(result.root_errors).toEqual([]);
  });

  it("non-git registered root with stageflow.yaml lists pipelines", async () => {
    const home = tempDir("sf-cat-nongit-");
    const boot = tempDir("sf-cat-boot-nongit-");
    const project = tempDir("sf-cat-proj-nongit-");
    writeMinimalCatalog(project, "hello");
    const store = createRunStore({ rootDir: home });
    const normalized = await store.ensureProject(project);
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
      projectRootFilter: normalized,
    });
    expect(result.root_errors).toEqual([]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hello",
          path: "pipelines/hello.pipeline.yaml",
          project_root: normalized,
        }),
      ]),
    );
  });

  it("non-git registered root without manifest lists empty", async () => {
    const home = tempDir("sf-cat-nongit-nomf-");
    const boot = tempDir("sf-cat-boot-nongit-nomf-");
    const project = tempDir("sf-cat-proj-nongit-nomf-");
    const store = createRunStore({ rootDir: home });
    const normalized = await store.ensureProject(project);
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
      projectRootFilter: normalized,
    });
    expect(result.items).toEqual([]);
    expect(result.root_errors).toEqual([]);
  });

  it("seeded root with manifest lists under symbolic project_root", async () => {
    const home = tempDir("sf-cat-seeded-");
    const boot = tempDir("sf-cat-boot-seeded-");
    const seeded = tempDir("sf-cat-seeded-path-");
    writeMinimalCatalog(seeded, "seeded-hello");
    const store = createRunStore({ rootDir: home });
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [{ id: "examples", path: seeded }],
    });
    expect(result.root_errors).toEqual([]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "seeded-hello",
          path: "pipelines/seeded-hello.pipeline.yaml",
          project_root: "examples",
        }),
      ]),
    );
  });

  it("git registered root with manifest still lists", async () => {
    const home = tempDir("sf-cat-git-");
    const boot = tempDir("sf-cat-boot-git-");
    const project = tempDir("sf-cat-proj-git-");
    writeMinimalCatalog(project, "git-hello");
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    const store = createRunStore({ rootDir: home });
    const normalized = await store.ensureProject(project);
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
      projectRootFilter: normalized,
    });
    expect(result.root_errors).toEqual([]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "git-hello",
          path: "pipelines/git-hello.pipeline.yaml",
          project_root: normalized,
        }),
      ]),
    );
  });

  it("empty list includes tip; non-empty omits tip", async () => {
    const home = tempDir("sf-cat-tip-");
    const boot = tempDir("sf-cat-boot-tip-");
    const store = createRunStore({ rootDir: home });
    const empty = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
    });
    expect(empty.items).toEqual([]);
    expect(empty.tip).toMatch(/Register a project root/);

    const project = tempDir("sf-cat-tip-proj-");
    writeMinimalCatalog(project, "hello");
    const normalized = await store.ensureProject(project);
    const filled = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [],
      projectRootFilter: normalized,
    });
    expect(filled.items.length).toBeGreaterThan(0);
    expect(filled.tip).toBeUndefined();
  });

  it("seeded examples-shaped tree with stageflow.yaml lists project_root examples", async () => {
    const home = tempDir("sf-cat-seeded-");
    const boot = tempDir("sf-cat-boot-seeded-");
    const examples = tempDir("sf-cat-examples-");
    writeFileSync(path.join(examples, "README.md"), "# examples\n", "utf8");
    writeMinimalCatalog(examples, "hello");
    writeFileSync(
      path.join(examples, "stageflow.yaml"),
      "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
      "utf8",
    );
    const store = createRunStore({ rootDir: home });
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      seededRoots: [{ id: "examples", path: examples }],
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.project_root === "examples")).toBe(true);
    expect(result.tip).toBeUndefined();
  });
});
