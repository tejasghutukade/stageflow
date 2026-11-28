import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_ID_PATTERN } from "../src/artifacts/keys.js";
import { STATIC_CONTENT_MAX_BYTES } from "../src/artifacts/limits.js";
import { listArtifacts, readArtifact } from "../src/artifacts/query.js";
import { runArtifactCommand } from "../src/cli/artifactCommand.js";
import { assertPreEmitChecks } from "../src/envelope/preEmitChecks.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import {
  listPublishedIdsForAttempt,
  publishSessionArtifact,
} from "../src/artifacts/sessionPublish.js";
import { withPublishedArtifacts } from "../src/cli/runOutput.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { STAGE_ARTIFACT_EXPECT_MAX } from "../src/config/stageArtifacts.js";
import { composeStagePiSystemPrompt, resolveStageToolNames } from "../src/agent/piAdapter.js";
import { appendArtifactPublishPrompt } from "../src/tools/publishArtifact.js";
import {
  createPublishArtifactTool,
  publishPathBytesReadForTests,
  readCappedPublishFile,
  resetPublishPathBytesReadForTests,
  setPublishFileOpenHookForTests,
} from "../src/tools/publishArtifact.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "../src/tools/stageToolNames.js";
import { PATH_DENIED_MESSAGE } from "../src/runread/readArtifact.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { StageConfig } from "../src/types/stage.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  setPublishFileOpenHookForTests(undefined);
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const io = {
  input: { schema: { type: "object" } },
  output: { schema: { type: "object" } },
};

function stage(artifacts?: unknown): Record<string, unknown> {
  return {
    id: "publish-note",
    system_prompt: "Publish the weekly note.",
    model: "anthropic/claude-sonnet-4-5",
    io,
    ...(artifacts !== undefined ? { artifacts } : {}),
  };
}

async function loadObject(raw: Record<string, unknown>) {
  const { loadStageFromObjectOutcome } = await import("../src/config/loadStage.js");
  return loadStageFromObjectOutcome(raw, {
    entryId: "publish-note",
    declaringPath: "inline.yaml",
  });
}

describe("stage artifacts YAML", () => {
  it("loads a fixture pipeline that opts in and lists expect ids", async () => {
    const loaded = await loadPipeline(path.join(fixtures, "pipelines/publish-note.pipeline.yaml"));
    expect(loaded.stages[0]?.artifacts).toEqual({ publish: true, expect: ["weekly-note"] });
  });

  it("omits the field when the block is absent or publish is false", async () => {
    const absent = await loadObject(stage());
    const off = await loadStageOutcome(path.join(fixtures, "stages/artifacts/publish-false.yaml"));
    expect(absent.ok && off.ok).toBe(true);
    if (!absent.ok || !off.ok) return;
    expect(absent.value.artifacts).toBeUndefined();
    expect(off.value.artifacts).toBeUndefined();
    const { artifacts: _ignored, ...rest } = off.value;
    expect(rest).toEqual({ ...rest, artifacts: undefined });
    expect("artifacts" in off.value).toBe(false);
  });

  it.each([
    ["expect without publish", path.join(fixtures, "stages/artifacts/expect-without-publish.yaml")],
    ["bad id", path.join(fixtures, "stages/artifacts/bad-id.yaml")],
    ["duplicate id", path.join(fixtures, "stages/artifacts/duplicate-expect.yaml")],
    ["unknown key", path.join(fixtures, "stages/artifacts/unknown-key.yaml")],
  ])("rejects %s with stage.invalid_artifacts", async (_name, file) => {
    const outcome = await loadStageOutcome(file);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_artifacts");
  });

  it("rejects the wrong types, too many ids, and expect beside publish false", async () => {
    const tooMany = Array.from({ length: STAGE_ARTIFACT_EXPECT_MAX + 1 }, (_, index) => `id${index}`);
    const cases = [
      stage({ publish: "yes" }),
      stage({ publish: true, expect: "weekly-note" }),
      stage({ publish: true, expect: tooMany }),
      stage({ publish: false, expect: ["weekly-note"] }),
      stage([]),
    ];
    for (const raw of cases) {
      const outcome = await loadObject(raw);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.issues[0]?.code).toBe("stage.invalid_artifacts");
    }
    expect(ARTIFACT_ID_PATTERN.test("weekly-note")).toBe(true);
  });
});

function promptInput(artifacts?: StageConfig["artifacts"]): StageRunInput {
  return {
    roots: buildStageRoots("/tmp/run-ws", "publish-note"),
    stage: {
      id: "publish-note",
      system_prompt: "Publish the weekly note.",
      model: "anthropic/claude-sonnet-4-5",
      ...(artifacts !== undefined ? { artifacts } : {}),
    },
    task: { id: "task", goal: "Write the note." },
    priorEnvelope: null,
  } as StageRunInput;
}

describe("stage artifact prompt and tools", () => {
  it("keeps the system prompt and tool list byte-identical when the stage does not opt in", () => {
    const plain = promptInput();
    const disabled = promptInput(undefined);
    const system = composeStagePiSystemPrompt(plain, "emit_stage_envelope", undefined, "write_stage_artifact");
    const again = composeStagePiSystemPrompt(disabled, "emit_stage_envelope", undefined, "write_stage_artifact");
    expect(system).toBe(again);
    expect(system).not.toContain("# Published artifacts");
    expect(appendArtifactPublishPrompt(plain.stage.system_prompt, undefined, false)).toBe(plain.stage.system_prompt);
    const tools = resolveStageToolNames("emit_stage_envelope", "write_stage_artifact");
    expect(resolveStageToolNames("emit_stage_envelope", "write_stage_artifact", undefined, undefined, false)).toEqual(tools);
    expect(tools).not.toContain(PUBLISH_ARTIFACT_TOOL_NAME);
    expect(resolveStageToolNames("emit_stage_envelope", "write_stage_artifact", undefined, ["confirm"], false)).not.toContain(
      PUBLISH_ARTIFACT_TOOL_NAME,
    );
  });

  it("adds the prompt section and the tool only when publish is on", () => {
    const system = composeStagePiSystemPrompt(
      promptInput({ publish: true, expect: ["weekly-note", "top-customers"] }),
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );
    expect(system).toContain("# Published artifacts");
    expect(system).toContain("weekly-note, top-customers");
    expect(system).toContain("static.markdown");
    expect(system.indexOf("# Stage assignment")).toBeLessThan(system.indexOf("# Published artifacts"));
    const userAssignment = system.slice(system.indexOf("# Stage assignment"));
    expect(userAssignment.startsWith("# Stage assignment")).toBe(true);
    expect(resolveStageToolNames("emit_stage_envelope", "write_stage_artifact", undefined, undefined, true)).toContain(
      PUBLISH_ARTIFACT_TOOL_NAME,
    );
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function publishTool(
  publish: (body: { id: string; kind: string; title: string; bytes: Buffer }) => Promise<{ key: string; version: number; unchanged?: boolean; project_root: string }>,
  workspace = "/tmp/run-ws",
) {
  return createPublishArtifactTool({
    runWorkspaceDir: workspace,
    stageId: "publish-note",
    attempt: 1,
    publish,
  });
}

describe("publish_artifact tool", () => {
  it("publishes each static kind through the host publisher", async () => {
    const seen: string[] = [];
    const tool = publishTool(async (body) => {
      seen.push(body.kind);
      return { key: `stage:publish-note:publish-note/${body.id}`, version: 1, project_root: "proj" };
    });
    const calls = [
      { id: "note", kind: "static.markdown", title: "Note", content: "# Note" },
      { id: "shot", kind: "static.image", title: "Shot", content_base64: PNG.toString("base64") },
      { id: "rows", kind: "static.table", title: "Rows", content: "name\nAda\n" },
      { id: "plain", kind: "static.text", title: "Plain", content: "hello" },
      { id: "page", kind: "static.html", title: "Page", content: "<p>Hi</p>" },
    ];
    for (const params of calls) {
      const result = await tool.execute("call", params);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ version: 1 });
    }
    expect(seen).toEqual(calls.map((call) => call.kind));
  });

  it("reads a path inside the attempt artifacts directory and refuses a path outside it", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-pub-path-"));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const artifacts = attemptArtifactsDir(workspace, "publish-note", 1);
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "note.md"), "hello");
    await writeFile(path.join(workspace, "secret.txt"), "nope");
    const seen: Buffer[] = [];
    const tool = publishTool(async (body) => {
      seen.push(body.bytes);
      return { key: "stage:publish-note:publish-note/note", version: 1, project_root: "proj" };
    }, workspace);
    const ok = await tool.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      path: "stages/publish-note/attempts/1/artifacts/note.md",
    });
    expect(ok.isError).toBeUndefined();
    expect(seen[0]?.toString("utf8")).toBe("hello");
    const denied = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "Note",
      path: "../secret.txt",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain(PATH_DENIED_MESSAGE);
    const foreign = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "Note",
      path: "stages/other/attempts/1/artifacts/note.md",
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]?.text).toContain(PATH_DENIED_MESSAGE);
  });

  it("returns a coded error and accepts the corrected call in the same attempt", async () => {
    let calls = 0;
    const tool = publishTool(async (body) => {
      calls += 1;
      if (calls === 1) {
        const { SessionPublishError } = await import("../src/artifacts/sessionPublish.js");
        throw new SessionPublishError("artifact.invalid_id", "Artifact id is not a valid slug: Nope", [
          { path: "id", message: "Artifact id is not a valid slug: Nope" },
        ]);
      }
      return { key: `stage:publish-note:publish-note/${body.id}`, version: 1, project_root: "proj" };
    });
    const first = await tool.execute("call", { id: "Nope", kind: "static.text", title: "T", content: "x" });
    expect(first.isError).toBe(true);
    const payload = JSON.parse(first.content[0]!.text) as { code: string; issues: Array<{ path: string }> };
    expect(payload.code).toBe("artifact.invalid_id");
    expect(payload.issues[0]?.path).toBe("id");
    const second = await tool.execute("call", { id: "note", kind: "static.text", title: "T", content: "x" });
    expect(second.isError).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("scrubs secrets from text before the host stores it and leaves image bytes unchanged", async () => {
    const secret = `ghp_${"a".repeat(24)}`;
    const stored: Array<{ kind: string; bytes: Buffer; title: string }> = [];
    const tool = publishTool(async (body) => {
      stored.push({ kind: body.kind, bytes: body.bytes, title: body.title });
      return { key: "stage:publish-note:publish-note/note", version: 1, project_root: "proj" };
    });
    await tool.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      content: `token ${secret}`,
    });
    expect(stored[0]?.bytes.toString("utf8")).not.toContain(secret);
    expect(stored[0]?.bytes.toString("utf8")).toContain("[redacted]");
    await tool.execute("call", {
      id: "shot",
      kind: "static.image",
      title: "Shot",
      content_base64: PNG.toString("base64"),
    });
    expect(stored[1]?.bytes.equals(PNG)).toBe(true);
    const error = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "T",
      content: "x",
      path: "also.md",
    });
    expect(error.isError).toBe(true);
    expect(error.content[0]?.text).not.toContain(secret);
    const encoded = await tool.execute("call", {
      id: "encoded",
      kind: "static.markdown",
      title: "Encoded",
      content_base64: Buffer.from(`token ${secret}`, "utf8").toString("base64"),
    });
    expect(encoded.isError).toBeUndefined();
    expect(stored[2]?.bytes.toString("utf8")).not.toContain(secret);
    expect(stored[2]?.bytes.toString("utf8")).toContain("[redacted]");
    const pem = ["-----BEGIN EC PRIVATE KEY-----", "MIIBogIBAAJBALFakeKeyMaterialForTestsOnly1234567890", "-----END EC PRIVATE KEY-----"].join("\n");
    await tool.execute("call", {
      id: "key",
      kind: "static.text",
      title: "Key",
      content_base64: Buffer.from(pem, "utf8").toString("base64"),
    });
    expect(stored.at(-1)?.bytes.toString("utf8")).toBe("[redacted]");
    expect(stored.at(-1)?.bytes.toString("utf8")).not.toContain("FakeKeyMaterial");
    const imageText = Buffer.from(`token ${secret}`, "utf8");
    await tool.execute("call", {
      id: "pixels",
      kind: "static.image",
      title: "Pixels",
      content_base64: imageText.toString("base64"),
    });
    expect(stored.at(-1)?.bytes.equals(imageText)).toBe(true);
  });

  it("rejects text that is not valid UTF-8 from a path or from base64", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-pub-utf8-"));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const artifacts = attemptArtifactsDir(workspace, "publish-note", 1);
    await mkdir(artifacts, { recursive: true });
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    await writeFile(path.join(artifacts, "note.md"), binary);
    let stored = 0;
    const tool = publishTool(async () => {
      stored += 1;
      return { key: "stage:publish-note:publish-note/note", version: 1, project_root: "proj" };
    }, workspace);
    const fromPath = await tool.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      path: "stages/publish-note/attempts/1/artifacts/note.md",
    });
    expect(fromPath.isError).toBe(true);
    const pathPayload = JSON.parse(fromPath.content[0]!.text) as { code: string; issues: Array<{ path: string }> };
    expect(pathPayload.code).toBe("artifact.invalid_shape");
    expect(pathPayload.issues[0]?.path).toBe("path");
    const fromBase64 = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "Note",
      content_base64: binary.toString("base64"),
    });
    expect(fromBase64.isError).toBe(true);
    const base64Payload = JSON.parse(fromBase64.content[0]!.text) as { code: string; issues: Array<{ path: string }> };
    expect(base64Payload.code).toBe("artifact.invalid_shape");
    expect(base64Payload.issues[0]?.path).toBe("content");
    expect(stored).toBe(0);
    const image = await tool.execute("call", {
      id: "shot",
      kind: "static.image",
      title: "Shot",
      content_base64: binary.toString("base64"),
    });
    expect(image.isError).toBeUndefined();
    expect(stored).toBe(1);
  });

  it("does not follow a symlink or a fifo swapped in before open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-pub-follow-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "note.txt");
    const secret = path.join(dir, "secret.txt");
    const linked = path.join(dir, "linked.txt");
    const fifo = path.join(dir, "pipe");
    await writeFile(file, "visible");
    await writeFile(secret, "hidden-secret");
    await symlink(secret, linked);
    execFileSync("mkfifo", [fifo]);
    resetPublishPathBytesReadForTests();
    expect(() => readCappedPublishFile(linked, 100)).toThrow(/Artifact path denied/);
    expect(publishPathBytesReadForTests()).toBe(0);
    resetPublishPathBytesReadForTests();
    expect(() => readCappedPublishFile(fifo, 100)).toThrow(/Artifact path denied/);
    expect(publishPathBytesReadForTests()).toBe(0);
    setPublishFileOpenHookForTests(() => {
      fs.rmSync(file);
      fs.symlinkSync(secret, file);
    });
    resetPublishPathBytesReadForTests();
    expect(() => readCappedPublishFile(file, 100)).toThrow(/Artifact path denied/);
    expect(publishPathBytesReadForTests()).toBe(0);
    expect(fs.readFileSync(secret, "utf8")).toBe("hidden-secret");
  });
});

describe("expect at emit", () => {
  it("rejects a success envelope until every expect id is published by this attempt", async () => {
    const published = new Set<string>();
    const emit = createEmitStageEnvelopeTool({ envelope: undefined }, { type: "object" }, undefined, undefined, {
      expectedArtifactIds: ["weekly-note"],
      readPublishedArtifactIds: async () => [...published],
    });
    const success = {
      status: "success",
      summary: "done",
      artifacts: [],
      payload: {},
    };
    const missing = await emit.execute("call", success);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("artifact.expected_missing");
    expect(missing.content[0]?.text).toContain("weekly-note");
    published.add("weekly-note");
    const accepted = await emit.execute("call", success);
    expect(accepted.isError).toBeUndefined();
    const failure = createEmitStageEnvelopeTool({ envelope: undefined }, { type: "object" }, undefined, undefined, {
      expectedArtifactIds: ["weekly-note"],
      readPublishedArtifactIds: async () => [],
    });
    const failed = await failure.execute("call", {
      status: "failure",
      summary: "stopped",
      artifacts: [],
    });
    expect(failed.isError).toBeUndefined();
  });
});

async function openStore(): Promise<{ store: RunStore; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-stage-pub-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-stage-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, project: registered };
}

describe("session publish adapter", () => {
  it("records the stage attempt on the published row", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store);
    expect(db).toBeDefined();
    if (!db) return;
    const roots = await catalogRootsForArtifacts(store);
    const result = await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
        projectRoot: project,
        source: { runId: "run-1", stageId: "publish-note", attempt: 2 },
      },
      { id: "weekly-note", kind: "static.markdown", title: "Weekly", bytes: Buffer.from("# Weekly\n") },
    );
    expect(result).toMatchObject({ key: "stage:publish-note:publish-note/weekly-note", version: 1 });
    expect(listPublishedIdsForAttempt(db, { runId: "run-1", stageId: "publish-note", attempt: 2 })).toEqual([
      "weekly-note",
    ]);
    expect(listPublishedIdsForAttempt(db, { runId: "run-1", stageId: "publish-note", attempt: 1 })).toEqual([]);
    const row = db.prepare(`SELECT source, source_run_id, source_stage_id, source_attempt FROM artifacts WHERE id = ?`).get("weekly-note") as {
      source: string;
      source_run_id: string;
      source_stage_id: string;
      source_attempt: number;
    };
    expect(row).toEqual({ source: "stage", source_run_id: "run-1", source_stage_id: "publish-note", source_attempt: 2 });
    const version = db
      .prepare(`SELECT source_run_id, source_stage_id, source_attempt FROM artifact_versions WHERE version = 1`)
      .get() as { source_run_id: string; source_stage_id: string; source_attempt: number };
    expect(version).toEqual({ source_run_id: "run-1", source_stage_id: "publish-note", source_attempt: 2 });
  });
});

describe("worker IPC", () => {
  it("publishes on the host and ignores a run id supplied by the worker", async () => {
    const { store, project } = await openStore();
    const worker = fileURLToPath(new URL("./fixtures/publishArtifactWorker.mjs", import.meta.url));
    const launcher = new StageProcessLauncher({
      cliEntry: worker,
      env: {
        PUBLISH_TEST_INPUT: JSON.stringify({
          id: "weekly-note",
          kind: "static.markdown",
          title: "Weekly",
          content_base64: Buffer.from("# Weekly\n").toString("base64"),
          runId: "forged-run",
        }),
      },
    });
    const stage: StageConfig = {
      id: "publish-note",
      system_prompt: "Publish the weekly note.",
      model: "anthropic/claude-sonnet-4-5",
      artifacts: { publish: true, expect: ["weekly-note"] },
    };
    const result = await launcher.launch({
      rootDir: project,
      factoryCwd: project,
      stageId: "publish-note",
      runId: "real-run",
      pipelineId: "publish-note",
      stage,
      attempt: 3,
    });
    expect(result).toEqual({ type: "succeeded" });
    const db = sqliteConnectionFromStore(store);
    const row = db
      ?.prepare(`SELECT source_run_id, source_stage_id, source_attempt, title FROM artifacts WHERE id = ?`)
      .get("weekly-note") as { source_run_id: string; source_stage_id: string; source_attempt: number; title: string };
    expect(row).toEqual({
      source_run_id: "real-run",
      source_stage_id: "publish-note",
      source_attempt: 3,
      title: "Weekly",
    });
  });

  it("refuses an oversized IPC publish without storing a row", async () => {
    const { store, project } = await openStore();
    const worker = fileURLToPath(new URL("./fixtures/publishArtifactOversizeWorker.mjs", import.meta.url));
    const launcher = new StageProcessLauncher({
      cliEntry: worker,
      env: { PUBLISH_OVERSIZE_B64: String(Math.ceil(STATIC_CONTENT_MAX_BYTES / 3) * 4 + 4) },
    });
    const stage: StageConfig = {
      id: "publish-note",
      system_prompt: "Publish the weekly note.",
      model: "anthropic/claude-sonnet-4-5",
      artifacts: { publish: true },
    };
    const result = await launcher.launch({
      rootDir: project,
      factoryCwd: project,
      stageId: "publish-note",
      runId: "real-run",
      pipelineId: "publish-note",
      stage,
      attempt: 1,
    });
    expect(result).toEqual({ type: "failed", reason: "artifact.too_large" });
    const db = sqliteConnectionFromStore(store);
    expect(db?.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
  });
});

describe("publish path size", () => {
  it("refuses a file over the cap without reading it, including a large sparse file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-pub-cap-"));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const artifacts = attemptArtifactsDir(workspace, "publish-note", 1);
    await mkdir(artifacts, { recursive: true });
    const six = path.join(artifacts, "six.bin");
    const fd = fs.openSync(six, "w");
    fs.ftruncateSync(fd, 6 * 1024 * 1024);
    fs.closeSync(fd);
    const sparse = path.join(artifacts, "sparse.bin");
    const sparseFd = fs.openSync(sparse, "w");
    fs.ftruncateSync(sparseFd, 200 * 1024 * 1024);
    fs.closeSync(sparseFd);
    resetPublishPathBytesReadForTests();
    const tool = publishTool(async () => {
      throw new Error("publisher should not be called");
    }, workspace);
    const started = Date.now();
    const huge = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "Note",
      path: "sparse.bin",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(huge.isError).toBe(true);
    expect(huge.content[0]?.text).toContain("artifact.too_large");
    const over = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "Note",
      path: "six.bin",
    });
    expect(over.isError).toBe(true);
    expect(over.content[0]?.text).toContain("artifact.too_large");
    expect(publishPathBytesReadForTests()).toBe(0);

    await writeFile(path.join(artifacts, "note.md"), "hello");
    const seen: Buffer[] = [];
    const reading = publishTool(async (body) => {
      seen.push(body.bytes);
      return { key: "stage:publish-note:publish-note/note", version: 1, project_root: "proj" };
    }, workspace);
    resetPublishPathBytesReadForTests();
    const ok = await reading.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      path: "note.md",
    });
    expect(ok.isError).toBeUndefined();
    expect(seen[0]?.toString("utf8")).toBe("hello");
    const smallRead = publishPathBytesReadForTests();
    expect(smallRead).toBeGreaterThan(0);
    expect(smallRead).toBeLessThanOrEqual(STATIC_CONTENT_MAX_BYTES + 1);

    await symlink(path.join(artifacts, "note.md"), path.join(artifacts, "link.md"));
    const linked = await reading.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      path: "link.md",
    });
    expect(linked.isError).toBe(true);
    expect(linked.content[0]?.text).toContain(PATH_DENIED_MESSAGE);
  });
});

describe("expect attempts and eval publishes", () => {
  it("counts an unchanged republish and rejects a later attempt that never published", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const body = { id: "weekly-note", kind: "static.markdown", title: "Weekly", bytes: Buffer.from("# Weekly\n") };
    const publish = (runId: string, attempt: number) =>
      publishSessionArtifact(
        { db, roots },
        {
          owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
          projectRoot: project,
          source: { runId, stageId: "publish-note", attempt },
        },
        body,
      );
    await publish("run-1", 1);
    const ids = (attempt: number) => listPublishedIdsForAttempt(db, { runId: "run-1", stageId: "publish-note", attempt });
    await expect(
      assertPreEmitChecks(
        { status: "success", summary: "ok", artifacts: [], payload: {} },
        { expectedArtifactIds: ["weekly-note"], readPublishedArtifactIds: async () => ids(1) },
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertPreEmitChecks(
        { status: "success", summary: "ok", artifacts: [], payload: {} },
        { expectedArtifactIds: ["weekly-note"], readPublishedArtifactIds: async () => ids(2) },
      ),
    ).rejects.toThrow(/artifact.expected_missing/);
    const again = await publish("run-1", 2);
    expect(again.unchanged).toBe(true);
    expect(again.version).toBe(1);
    await expect(
      assertPreEmitChecks(
        { status: "success", summary: "ok", artifacts: [], payload: {} },
        { expectedArtifactIds: ["weekly-note"], readPublishedArtifactIds: async () => ids(2) },
      ),
    ).resolves.toBeUndefined();
    const version = db.prepare(`SELECT source_run_id, source_attempt FROM artifact_versions WHERE version = 1`).get() as {
      source_run_id: string;
      source_attempt: number;
    };
    expect(version).toEqual({ source_run_id: "run-1", source_attempt: 1 });
  });

  it("hides an eval-origin publish from list, search, and the CLI", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const evalRun = await store.createRun({
      pipelineId: "publish-note",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
      origin: "eval",
    });
    const normal = await store.createRun({
      pipelineId: "publish-note",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
    });
    await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
        projectRoot: project,
        source: { runId: evalRun.runId, stageId: "publish-note", attempt: 1 },
      },
      { id: "eval-note", kind: "static.markdown", title: "Eval note", bytes: Buffer.from("# hidden eval note\n") },
    );
    await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
        projectRoot: project,
        source: { runId: normal.runId, stageId: "publish-note", attempt: 1 },
      },
      { id: "visible-note", kind: "static.markdown", title: "Visible note", bytes: Buffer.from("# visible note\n") },
    );
    expect(db.prepare(`SELECT id, hidden FROM artifacts ORDER BY id`).all()).toEqual([
      { id: "eval-note", hidden: 1 },
      { id: "visible-note", hidden: 0 },
    ]);
    expect(listArtifacts(db, { q: "note", limit: 20 }, roots).artifacts.map((row) => row.id)).toEqual(["visible-note"]);
    expect(listArtifacts(db, { limit: 20 }, roots).artifacts.map((row) => row.id)).toEqual(["visible-note"]);
    expect(() => readArtifact(db, "stage:publish-note:publish-note", "eval-note", project, roots)).toThrow(/not found|artifact.not_found/i);
    const lines: string[] = [];
    const code = await runArtifactCommand(["list", "--json"], {
      cwd: project,
      projectRoot: project,
      io: { log: (line) => lines.push(line), error: () => undefined },
    });
    expect(code).toBe(0);
    const page = JSON.parse(lines.join("\n")) as { artifacts: Array<{ id: string }> };
    expect(page.artifacts.map((row) => row.id)).toEqual(["visible-note"]);
  });

  it("keeps a production artifact when an eval run publishes the same id", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const production = await store.createRun({
      pipelineId: "publish-note",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
    });
    const evalRun = await store.createRun({
      pipelineId: "publish-note",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
      origin: "eval",
    });
    const owner = { kind: "stage" as const, pipeline: "publish-note", stage: "publish-note" };
    const first = await publishSessionArtifact(
      { db, roots },
      { owner, projectRoot: project, source: { runId: production.runId, stageId: "publish-note", attempt: 1 } },
      { id: "note", kind: "static.markdown", title: "Production", bytes: Buffer.from("# production\n") },
    );
    const before = db.prepare(`SELECT key, hidden, current_version, title FROM artifacts WHERE id = 'note'`).all();
    const evalPublish = await publishSessionArtifact(
      { db, roots },
      { owner, projectRoot: project, source: { runId: evalRun.runId, stageId: "publish-note", attempt: 1 } },
      { id: "note", kind: "static.markdown", title: "Eval copy", bytes: Buffer.from("# eval copy\n") },
    );
    expect(evalPublish.key).toBe("eval:stage:publish-note:publish-note/note");
    expect(db.prepare(`SELECT key, hidden, current_version, title FROM artifacts WHERE key = ?`).get(
      db.prepare(`SELECT key FROM artifacts WHERE id = 'note' AND hidden = 0`).pluck().get(),
    )).toEqual(before[0]);
    expect(db.prepare(`SELECT hidden FROM artifacts WHERE key LIKE '%eval:stage:%'`).get()).toEqual({ hidden: 1 });
    expect(listArtifacts(db, { limit: 20 }, roots).artifacts.map((row) => row.title)).toEqual(["Production"]);
    const again = await publishSessionArtifact(
      { db, roots },
      { owner, projectRoot: project, source: { runId: production.runId, stageId: "publish-note", attempt: 2 } },
      { id: "note", kind: "static.markdown", title: "Production 2", bytes: Buffer.from("# production two\n") },
    );
    expect(again.version).toBe(2);
    expect(again.key).toBe(first.key);
    expect(
      listPublishedIdsForAttempt(db, { runId: evalRun.runId, stageId: "publish-note", attempt: 1 }),
    ).toEqual(["note"]);
    const listed = withPublishedArtifacts(store, evalRun.runId, [{ stage_id: "publish-note", status: "succeeded" }]);
    expect(listed[0]?.published_artifacts?.[0]?.key).toBe("eval:stage:publish-note:publish-note/note");
    await expect(
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "eval:publish-note", stage: "publish-note" },
        projectRoot: project,
        id: "note",
        kind: "static.markdown",
        title: "Nope",
        bytes: Buffer.from("x"),
        publishSource: "api",
        roots,
      }),
    ).rejects.toMatchObject({ code: "artifact.invalid_shape" });
  });

  it("lists only the artifact published by that pipeline and project", async () => {
    const { store } = await openStore();
    const projectA = await mkdtemp(path.join(tmpdir(), "sf-pub-a-"));
    const projectB = await mkdtemp(path.join(tmpdir(), "sf-pub-b-"));
    cleanups.push(async () => {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    });
    const rootA = await store.ensureProject(projectA);
    const rootB = await store.ensureProject(projectB);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const runA = await store.createRun({ pipelineId: "pipe-p", taskYaml: "id: t\ngoal: g\n", projectRoot: rootA });
    const runB = await store.createRun({ pipelineId: "pipe-q", taskYaml: "id: t\ngoal: g\n", projectRoot: rootB });
    const body = { id: "note", kind: "static.markdown", title: "Note", bytes: Buffer.from("# note\n") };
    await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "pipe-p", stage: "publish-note" },
        projectRoot: rootA,
        source: { runId: runA.runId, stageId: "publish-note", attempt: 1 },
      },
      { ...body, title: "From P" },
    );
    await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "pipe-q", stage: "publish-note" },
        projectRoot: rootB,
        source: { runId: runB.runId, stageId: "publish-note", attempt: 1 },
      },
      { ...body, title: "From Q", bytes: Buffer.from("# other\n") },
    );
    const runC = await store.createRun({ pipelineId: "pipe-q", taskYaml: "id: t\ngoal: g\n", projectRoot: rootA });
    db.prepare(
      `INSERT INTO artifact_attempt_publishes (run_id, stage_id, attempt, artifact_key, version, unchanged, created_at)
       VALUES (?, 'publish-note', 1, 'note', 1, 0, '2026-01-01T00:00:00.000Z')`,
    ).run(runC.runId);
    const stages = [{ stage_id: "publish-note", status: "succeeded" as const }];
    expect(withPublishedArtifacts(store, runA.runId, stages)[0]?.published_artifacts).toEqual([
      { key: "stage:pipe-p:publish-note/note", version: 1, kind: "static.markdown", title: "From P" },
    ]);
    expect(withPublishedArtifacts(store, runB.runId, stages)[0]?.published_artifacts).toEqual([
      { key: "stage:pipe-q:publish-note/note", version: 1, kind: "static.markdown", title: "From Q" },
    ]);
    expect(withPublishedArtifacts(store, runC.runId, stages)[0]?.published_artifacts).toBeUndefined();
    expect(listPublishedIdsForAttempt(db, { runId: runA.runId, stageId: "publish-note", attempt: 1 })).toEqual(["note"]);
    expect(listPublishedIdsForAttempt(db, { runId: runB.runId, stageId: "publish-note", attempt: 1 })).toEqual(["note"]);
    expect(listPublishedIdsForAttempt(db, { runId: runC.runId, stageId: "publish-note", attempt: 1 })).toEqual([]);
    await expect(
      assertPreEmitChecks(
        { status: "success", summary: "ok", artifacts: [], payload: {} },
        {
          expectedArtifactIds: ["note"],
          readPublishedArtifactIds: async () =>
            listPublishedIdsForAttempt(db, { runId: runB.runId, stageId: "publish-note", attempt: 1 }),
        },
      ),
    ).resolves.toBeUndefined();
  });
});
