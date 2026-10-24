import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentService } from "../src/agents/service.js";
import { AgentStore } from "../src/agents/store.js";
import { checkDatasetAgainstAgent } from "../src/config/datasetAgentCheck.js";
import { installEvalSample } from "../src/config/installEvalSample.js";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { loadEvalOutcome, resolveConversation, resolveEvalPaths } from "../src/config/loadEval.js";
import { resolveAgentTarget } from "../src/config/resolveAgentTarget.js";
import { validateEval } from "../src/config/validateEval.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { agentEvalHarness } from "./helpers/agentEvalHarness.js";
import { REPO_ROOT } from "./helpers/fixturePaths.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const SAMPLE_DIR = path.join(REPO_ROOT, "examples", "evals");
const MANIFEST = "version: 1\nmodel: anthropic/claude-haiku-4-5\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function agentProject(manifest: string | null = MANIFEST) {
  const root = await tempDir("sf-agent-sample-");
  const home = await tempDir("sf-agent-sample-home-");
  bindStageflowHomeForTests(home);
  if (manifest !== null) await writeFile(path.join(root, "stageflow.yaml"), manifest);
  const { store, connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
  await store.ensureProject(root);
  cleanups.push(() => store.close());
  const service = new AgentService({ store: new AgentStore(connection) });
  return { root, service };
}

describe("examples/evals agent sample", () => {
  it("has a script-mode dataset of 6 valid scenarios", async () => {
    const dataset = await loadDatasetFile(path.join(SAMPLE_DIR, "support-sample.dataset.jsonl"), { root: REPO_ROOT });
    expect(dataset.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(dataset.cases.map((c) => c.id)).toEqual(["s001", "s002", "s003", "s004", "s005", "s006"]);
    const checks = checkDatasetAgainstAgent(dataset.cases, resolveConversation(undefined));
    expect(checks.filter((c) => !c.valid)).toEqual([]);
    for (const c of dataset.cases) {
      expect((c.input as { mode?: string }).mode).toBe("script");
      expect(Object.keys(c.input).sort()).toEqual(["mode", "script"]);
    }
    const expected = dataset.cases.map((c) => c.expected as { tools: string[]; forbidden_tools: string[] });
    expect(expected.every((e) => e.forbidden_tools.length > 0)).toBe(true);
    expect(expected.some((e) => e.tools.length > 0)).toBe(true);
  });

  it("uses only judge-free graders and a read-only agent", async () => {
    const text = await readFile(path.join(SAMPLE_DIR, "support-sample.eval.yaml"), "utf8");
    const doc = parseYaml(text);
    const types = (doc.graders as Array<{ type: string }>).map((g) => g.type);
    expect(types.filter((t) => t === "rubric" || t === "goal_reached")).toEqual([]);
    expect(doc.defaults.judge).toBeUndefined();
    expect(doc.conversation).toMatchObject({ mode: "script", max_turns: 4, tools: "read_only", approvals: "record_only" });
    expect(doc.defaults).toMatchObject({ repeats: 2, pass_threshold: 0.8, max_cost_usd: 1, concurrency: 2 });
    const agent = parseYaml(await readFile(path.join(SAMPLE_DIR, "support-sample.agent.yaml"), "utf8"));
    expect(agent.id).toBe("support_sample");
    expect(agent.tools).toEqual({ builtin: ["read"] });
    expect(agent.approvals).toBeUndefined();
  });

  it("installs the agent, eval and dataset into a fresh project and validates with no findings", async () => {
    const { root, service } = await agentProject();
    const result = await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent", agents: service });
    expect(result).toEqual({ evalId: "support-sample" });
    expect(await readdir(path.join(root, "evals"))).toEqual(["support-sample.eval.yaml"]);
    expect(await readdir(path.join(root, "datasets"))).toEqual(["support-sample.dataset.jsonl"]);
    expect(await readdir(path.join(root, "agents"))).toEqual(["support_sample.agent.yaml"]);

    const detail = await service.get(root, "support_sample");
    expect(detail.definition?.enabled).toBe(true);
    expect(detail.definition?.web_chat.enabled).toBe(false);
    expect(detail.agent.issues).toEqual([]);

    const evalPath = path.join(root, "evals", "support-sample.eval.yaml");
    const outcome = await loadEvalOutcome(evalPath, root);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues));
    const paths = resolveEvalPaths(outcome.value.file, evalPath);
    expect(path.relative(root, paths.datasetPath)).toBe("datasets/support-sample.dataset.jsonl");
    const dataset = await loadDatasetFile(paths.datasetPath, { root });
    expect(dataset.cases).toHaveLength(6);
    const resolved = await resolveAgentTarget(outcome.value.file, root, service);
    expect(resolved.ok).toBe(true);
    const findings = await validateEval(outcome.value, { projectRoot: root, datasetReport: dataset, agents: service });
    expect(findings).toEqual([]);
  });

  it("fails clearly when the project has no default model, and writes nothing", async () => {
    const { root, service } = await agentProject("version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n");
    await expect(
      installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent", agents: service }),
    ).rejects.toMatchObject({ code: "SAMPLE_NO_DEFAULT_MODEL" });
    await expect(readdir(path.join(root, "evals"))).rejects.toThrow();
    await expect(service.get(root, "support_sample")).rejects.toThrow();
  });

  it("installs once and answers SAMPLE_EXISTS after", async () => {
    const { root, service } = await agentProject();
    await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent", agents: service });
    await expect(
      installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent", agents: service }),
    ).rejects.toMatchObject({ code: "SAMPLE_EXISTS" });
  });

  it("refuses when an agent with the sample id already exists", async () => {
    const { root, service } = await agentProject();
    await service.create(root, { id: "support_sample", name: "Mine", instructions: "x" }, { source: "api" });
    await expect(
      installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent", agents: service }),
    ).rejects.toMatchObject({ code: "SAMPLE_EXISTS" });
    await expect(readdir(path.join(root, "evals"))).rejects.toThrow();
  });

  it("needs an agent service", async () => {
    const { root } = await agentProject();
    await expect(
      installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR, kind: "agent" }),
    ).rejects.toMatchObject({ code: "SAMPLE_AGENTS_UNAVAILABLE" });
  });

  it("leaves the stage sample alone when no kind is given", async () => {
    const root = await tempDir("sf-agent-sample-stage-");
    await writeFile(path.join(root, "stageflow.yaml"), MANIFEST);
    const result = await installEvalSample({ projectRoot: root, sourceDir: SAMPLE_DIR });
    expect(result).toEqual({ evalId: "critique-sample" });
    await expect(readdir(path.join(root, "agents"))).rejects.toThrow();
  });
});

describe("POST /api/evals/sample with kind agent", () => {
  it("installs the agent sample through the route and 422s without a default model", async () => {
    const h = await agentEvalHarness();
    try {
      const noModel = await h.post("/api/evals/sample", { project_root: h.root, kind: "agent" });
      expect(noModel.status).toBe(422);
      expect(noModel.body.code).toBe("SAMPLE_NO_DEFAULT_MODEL");

      await writeFile(path.join(h.root, "stageflow.yaml"), MANIFEST);
      const installed = await h.post("/api/evals/sample", { project_root: h.root, kind: "agent" });
      expect(installed.status).toBe(201);
      expect(installed.body.eval_id).toBe("support-sample");
      const detail = await h.service.get(h.root, "support_sample");
      expect(detail.definition?.enabled).toBe(true);

      const again = await h.post("/api/evals/sample", { project_root: h.root, kind: "agent" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("SAMPLE_EXISTS");

      const badKind = await h.post("/api/evals/sample", { project_root: h.root, kind: "team" });
      expect(badKind.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
