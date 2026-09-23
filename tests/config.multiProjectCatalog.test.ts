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

describe("resolveCatalogRoots + multiProjectCatalog", () => {
  it("includes boot root even with zero runs", async () => {
    const home = tempDir("sf-cat-home-");
    const boot = tempDir("sf-cat-boot-");
    const store = createRunStore({ rootDir: home });
    const roots = await resolveCatalogRoots({ store, bootCwd: boot });
    expect(roots.some((r) => r.kind === "boot" && r.path === path.resolve(boot))).toBe(
      true,
    );
  });

  it("unknown project_root filter returns coded error", async () => {
    const home = tempDir("sf-cat-unk-");
    const boot = tempDir("sf-cat-boot2-");
    const store = createRunStore({ rootDir: home });
    const result = await listPipelinesMultiProject({
      store,
      bootCwd: boot,
      projectRootFilter: "/no/such/root",
    });
    expect(result.items).toEqual([]);
    expect(result.root_errors[0]?.code).toBe("unknown_project_root");
  });

  it("vanished root yields catalog_root_unreadable and continues", async () => {
    const home = tempDir("sf-cat-vanish-");
    const boot = tempDir("sf-cat-boot3-");
    writeFileSync(
      path.join(boot, "stageflow.yaml"),
      "version: 1\ncatalog:\n  pipelines: []\n  tasks: []\n",
      "utf8",
    );
    const vanished = path.join(home, "gone");
    mkdirSync(vanished);
    const store = createRunStore({ rootDir: home });
    // Simulate a registered root by writing via a fake listProjectRoots wrap.
    const wrapped = {
      ...store,
      listProjectRoots: async () => [vanished, boot],
    };
    rmSync(vanished, { recursive: true, force: true });
    const result = await listPipelinesMultiProject({
      store: wrapped as typeof store,
      bootCwd: boot,
    });
    expect(
      result.root_errors.some((e) => e.code === "catalog_root_unreadable"),
    ).toBe(true);
  });
});
