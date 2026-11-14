import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { validateCatalog } from "../src/config/validateCatalog.js";
import type { ModelCatalogSnapshot } from "../src/models/catalog.js";
import {
  installPendingStarters,
  installStartersWhenConnected,
  resolvePackagedStartersPath,
  STARTERS_PENDING_FILE,
  startersPending,
  withPipelineModel,
} from "../src/project/starters.js";
import { ensureWorkspaceCatalog, resetWorkspaceProvisionForTests } from "../src/project/workspaceCatalog.js";

const MODEL = "openrouter/test/model";
const STARTERS = ["draft-with-approval", "parallel-research", "topic-brief", "triage-and-route"];

const homes: string[] = [];
async function freshWorkspace(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-starters-"));
  homes.push(home);
  const result = ensureWorkspaceCatalog(home);
  expect(result.ok).toBe(true);
  return result.path;
}

function fakeCatalog(connected: boolean) {
  const snapshot: ModelCatalogSnapshot = {
    providers: connected ? [{ id: "openrouter", name: "OpenRouter", source: "live", models: [] }] : [],
    models: [],
    fetchedAt: new Date(0).toISOString(),
  };
  return {
    snapshot: async () => snapshot,
    refresh: async () => snapshot,
    defaultModel: async () => MODEL,
  };
}

afterEach(async () => {
  resetWorkspaceProvisionForTests();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("starters", () => {
  it("finds the packaged starters folder", () => {
    expect(resolvePackagedStartersPath()).toBe(path.join(process.cwd(), "starters"));
  });

  it("marks only a newly created workspace as pending", async () => {
    const ws = await freshWorkspace();
    expect(startersPending(ws)).toBe(true);

    await rm(path.join(ws, STARTERS_PENDING_FILE));
    ensureWorkspaceCatalog(path.dirname(ws));
    expect(startersPending(ws)).toBe(false);
  });

  it("copies every starter once, fills the pipeline model and clears the marker", async () => {
    const ws = await freshWorkspace();
    const result = await installPendingStarters({ workspacePath: ws, model: MODEL });
    expect(result.installed).toBe(true);
    expect(startersPending(ws)).toBe(false);
    expect((await readdir(path.join(ws, "starters"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(STARTERS);

    for (const name of STARTERS) {
      const text = await readFile(path.join(ws, "starters", name, `${name}.pipeline.yaml`), "utf8");
      expect((parseYaml(text) as { model?: string }).model).toBe(MODEL);
      expect(text.split("\n")[1]).toBe(`model: ${MODEL}`);
    }

    await rm(path.join(ws, "starters", "topic-brief"), { recursive: true });
    expect((await installPendingStarters({ workspacePath: ws, model: MODEL })).installed).toBe(false);
    expect(existsSync(path.join(ws, "starters", "topic-brief"))).toBe(false);
  });

  it("never overwrites a file that is already there", async () => {
    const ws = await freshWorkspace();
    const sourceDir = await mkdtemp(path.join(tmpdir(), "sf-starters-src-"));
    homes.push(sourceDir);
    await writeFile(path.join(sourceDir, "README.md"), "packaged\n");
    await writeFile(path.join(sourceDir, "a.pipeline.yaml"), "id: a\nstages: []\n");
    await mkdir(path.join(ws, "starters"), { recursive: true });
    await writeFile(path.join(ws, "starters", "README.md"), "mine\n");
    const result = await installPendingStarters({ workspacePath: ws, model: MODEL, sourceDir });
    expect(result.files).toEqual([path.join("starters", "a.pipeline.yaml")]);
    expect(await readFile(path.join(ws, "starters", "README.md"), "utf8")).toBe("mine\n");
  });

  it("keeps a model the pipeline already sets", () => {
    expect(withPipelineModel("id: a\nmodel: x/y\nstages: []\n", MODEL)).toBe("id: a\nmodel: x/y\nstages: []\n");
  });

  it("is off under STAGEFLOW_NO_STARTERS and waits for a connected provider", async () => {
    const ws = await freshWorkspace();
    const off = await installStartersWhenConnected({ cwd: ws, workspacePath: ws, catalog: fakeCatalog(true) });
    expect(off.installed).toBe(false);

    const notYet = await installStartersWhenConnected({ cwd: ws, workspacePath: ws, catalog: fakeCatalog(false), env: {} });
    expect(notYet.installed).toBe(false);
    expect(startersPending(ws)).toBe(true);

    const done = await installStartersWhenConnected({ cwd: ws, workspacePath: ws, refresh: true, catalog: fakeCatalog(true), env: {} });
    expect(done.installed).toBe(true);
    expect(startersPending(ws)).toBe(false);
  });

  it("installed starters pass strict validation and load with the expected shape", async () => {
    const ws = await freshWorkspace();
    await installPendingStarters({ workspacePath: ws, model: MODEL });
    const result = await validateCatalog({ cwd: ws, strict: true });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);

    const triage = await loadPipeline(path.join(ws, "starters", "triage-and-route", "triage-and-route.pipeline.yaml"));
    const classify = triage.dag.nodes.filter((n) => n.needsEdges.some((e) => e.id === "classify"));
    expect(classify.map((n) => n.id).sort()).toEqual(["handle-bug", "handle-feature-request", "handle-question"]);
    expect(classify.every((n) => n.needsEdges[0]?.if !== undefined)).toBe(true);

    const research = await loadPipeline(path.join(ws, "starters", "parallel-research", "parallel-research.pipeline.yaml"));
    const join = research.dag.nodes.find((n) => n.id === "synthesize");
    expect(join?.needsEdges.map((e) => e.id).sort()).toEqual(["case-against", "case-for", "practical-impact"]);

    const approval = await loadPipeline(path.join(ws, "starters", "draft-with-approval", "draft-with-approval.pipeline.yaml"));
    expect(approval.stages.find((s) => s.id === "draft")?.pre_emit_checks).toEqual([
      { id: "draft-approved", type: "gate", kind: "artifact_backed" },
    ]);
    for (const stage of [...triage.stages, ...research.stages, ...approval.stages]) expect(stage.model).toBe(MODEL);
  });
});
