import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createCompletedOnlyStageHandle, type StageRunInput } from "../src/agent/port.js";
import { releaseChannelHost } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const roots: string[] = [];
let provider: ReturnType<typeof fakeChannelProvider>;
beforeEach(() => {
  provider = fakeChannelProvider();
  registerChannelProvider(provider);
  process.env.CH_TEST_TOKEN = "super-secret-token-value";
});
afterEach(async () => {
  unregisterChannelProvider("fake");
  delete process.env.CH_TEST_TOKEN;
  for (const root of roots.splice(0)) { await releaseChannelHost(root); await rm(root, { recursive: true, force: true }); }
});

async function workspace(stageChannels: string, pipelineChannels = "") {
  const root = await mkdtemp(path.join(tmpdir(), "sf-chboot-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), "version: 1\nconnections:\n  - id: ops\n    provider: fake\n    config: { inbox: ops@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n");
  await mkdir(path.join(root, "pipelines")); await mkdir(path.join(root, "stages"));
  await writeFile(path.join(root, "pipelines", "notify.pipeline.yaml"), `id: notify\n${pipelineChannels}stages:\n  - id: notify\n    uses: ../stages/notify.yaml\n    entry: true\n`);
  await writeFile(path.join(root, "stages", "notify.yaml"), `id: notify\nmodel: model\nsystem_prompt: notify\n${stageChannels}io:\n  input:\n    schema: { type: object }\n  output:\n    schema: { type: object }\n`);
  const loaded = await loadPipeline("pipelines/notify.pipeline.yaml", { cwd: root });
  const store = createRunStore({ rootDir: root });
  const run = await store.createRun({ pipelineId: "notify", taskYaml: "id: notification\ngoal: Notify\n" });
  return { root, loaded, store, run };
}

const channelsYaml = "channels:\n  - connection: ops\n    to: '#releases'\n    operations: [send]\n";

describe("in-process stage bootstrap", () => {
  it("gives the agent scoped channels and sends through the host", async () => {
    const { root, loaded, store, run } = await workspace(channelsYaml);
    let observed: StageRunInput | undefined;
    const agent = { openStage(value: StageRunInput) { observed = value; return createCompletedOnlyStageHandle({ stageId: "notify", run: async () => {
      await value.channels!.send({ text: "shipped", operationKey: "k" });
      return { ok: true, envelope: { status: "success", summary: "sent", artifacts: [] } };
    } }); } };
    const opened = await openStageAttempt({ agent, store, runId: run.runId, stage: loaded.stages[0], dag: loaded.dag,
      task: { id: "notification", goal: "Notify" }, workspaceDir: run.workspaceDir, factoryCwd: root });
    expect(opened.ok).toBe(true);
    if (opened.ok) { expect(await opened.handle.next()).toMatchObject({ status: "completed", result: { ok: true } }); await opened.handle.close(); }
    expect(observed?.channels).toBeDefined();
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ target: "#releases", message: { text: "shipped" }, context: { runId: run.runId, stageId: "notify" } });
  });

  it("inherits pipeline channels and passes none to a stage that has none", async () => {
    const withDefaults = await workspace("", channelsYaml);
    let observed: StageRunInput | undefined;
    const agent = { openStage(value: StageRunInput) { observed = value; return createCompletedOnlyStageHandle({ stageId: "notify", run: async () => ({ ok: true, envelope: { status: "success", summary: "", artifacts: [] } }) }); } };
    const a = await openStageAttempt({ agent, store: withDefaults.store, runId: withDefaults.run.runId, stage: withDefaults.loaded.stages[0], dag: withDefaults.loaded.dag,
      task: { id: "n", goal: "n" }, workspaceDir: withDefaults.run.workspaceDir, factoryCwd: withDefaults.root });
    expect(a.ok).toBe(true);
    expect(observed?.channels).toBeDefined();
    const none = await workspace("");
    observed = undefined;
    const b = await openStageAttempt({ agent, store: none.store, runId: none.run.runId, stage: none.loaded.stages[0], dag: none.loaded.dag,
      task: { id: "n", goal: "n" }, workspaceDir: none.run.workspaceDir, factoryCwd: none.root });
    expect(b.ok).toBe(true);
    expect(observed?.channels).toBeUndefined();
  });

  it("refuses to open a stage whose connection is gone", async () => {
    const { root, loaded, store, run } = await workspace(channelsYaml);
    await writeFile(path.join(root, "connections.yaml"), "version: 1\n");
    await releaseChannelHost(root);
    const agent = { openStage() { throw new Error("must not open"); } };
    const opened = await openStageAttempt({ agent: agent as never, store, runId: run.runId, stage: loaded.stages[0], dag: loaded.dag,
      task: { id: "n", goal: "n" }, workspaceDir: run.workspaceDir, factoryCwd: root });
    expect(opened).toMatchObject({ ok: false, reason: "CHANNEL_NOT_FOUND" });
  });
});
