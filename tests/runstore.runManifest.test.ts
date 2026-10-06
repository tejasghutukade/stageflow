import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import {
  buildInitialRunManifest,
  collectMcpEnvNamedSecrets,
  finaliseRunManifest,
  finaliseStoredRunManifest,
  parseRunManifest,
  patchRunManifest,
  redactMcpServers,
  redactRunManifest,
  sha256Hex,
  withStageResolvedModel,
  type RunManifestV1,
} from "../src/runstore/runManifest.js";
import {
  clearNamedSecretsForTests,
  registerNamedSecrets,
} from "../src/logging/namedSecrets.js";
import type { LoadedStageConfig } from "../src/types/stage.js";

const stages: LoadedStageConfig[] = [
  {
    id: "implement",
    system_prompt: "do work",
    model: "anthropic/claude-sonnet-4",
    model_tier: "pipeline",
  },
];

describe("runManifest builder", () => {
  afterEach(() => {
    clearNamedSecretsForTests();
  });

  it("builds v1 manifest with host, caller, pipeline/task digests, skills, toolchain, authored models", () => {
    const secret = "super-secret-token-xx";
    registerNamedSecrets([{ name: "GITHUB_TOKEN", value: secret }]);
    const body = JSON.stringify({
      id: "p",
      stages: [{ id: "implement", system_prompt: `token ${secret}` }],
    });
    const manifest = buildInitialRunManifest({
      runId: "run_test",
      createdAt: "2026-09-23T12:00:00.000Z",
      callerId: "ci",
      surface: "mcp",
      binding: { kind: "unbound" },
      pipelineSource: "inline",
      pipelineBody: body,
      taskYaml: "id: t\ngoal: g\n",
      skills: {
        archify: { "SKILL.md": "# Archify\n" },
      },
      stages,
      toolchain: [
        {
          tool: "node",
          required: ">=22",
          found: "22.19.0",
          path: "/usr/bin/node",
          status: "ok",
          origin: "path",
        },
      ],
      namedSecrets: [{ name: "GITHUB_TOKEN", value: secret }],
    });

    expect(manifest.manifest_version).toBe(1);
    expect(manifest.run_id).toBe("run_test");
    expect(manifest.finalised_at).toBeUndefined();
    expect(manifest.host.stageflow_version).toBeTruthy();
    expect(manifest.host.schema_version).toBeGreaterThan(0);
    expect(manifest.caller).toEqual({ caller_id: "ci", surface: "mcp" });
    expect(manifest.pipeline.source).toBe("inline");
    expect(manifest.pipeline.bytes_sha256).toBe(sha256Hex(body));
    expect(JSON.stringify(manifest.pipeline.body)).not.toContain(secret);
    expect(manifest.task.bytes_sha256).toBe(sha256Hex("id: t\ngoal: g\n"));
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0]?.origin).toBe("run");
    expect(manifest.skills[0]?.digest).toMatch(/^sha256:/);
    expect(manifest.stages[0]?.model).toEqual({
      authored: "anthropic/claude-sonnet-4",
      authored_tier: "pipeline",
    });
    expect(manifest.toolchain[0]?.tool).toBe("node");
    expect(manifest.toolchain[0]?.resolved).toBe("22.19.0");
  });

  it("readers branch on manifest_version", () => {
    expect(parseRunManifest({ manifest_version: 1, run_id: "r" })).toMatchObject({
      manifest_version: 1,
    });
    expect(parseRunManifest({ manifest_version: 99 })).toBeNull();
    expect(parseRunManifest(null)).toBeNull();
  });

  it("redacts MCP env secrets on insert", () => {
    const token = "ghp_interpolated_secret_xx";
    const servers = {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: token },
      },
    };
    const named = collectMcpEnvNamedSecrets(servers);
    expect(named).toEqual([{ name: "github.GITHUB_TOKEN", value: token }]);
    const redacted = redactMcpServers(servers, named);
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(JSON.stringify(redacted)).toMatch(/\[redacted/);
  });

  it("appends resolved model and finalises", () => {
    const base = buildInitialRunManifest({
      runId: "run_partial",
      createdAt: "2026-09-23T12:00:00.000Z",
      callerId: null,
      surface: "cli",
      binding: { kind: "unbound" },
      pipelineSource: "path",
      pipelinePath: "/p.pipeline.yaml",
      taskYaml: "id: t\ngoal: g\n",
      stages,
      toolchain: [],
    });
    const mid = withStageResolvedModel(base, "implement", {
      model: "claude-sonnet-4-20250514",
      thinkingLevel: "medium",
    });
    expect(mid.stages[0]?.model.resolved).toBe("claude-sonnet-4-20250514");
    expect(mid.stages[0]?.model.thinking_level).toBe("medium");
    expect(mid.finalised_at).toBeUndefined();
    const done = finaliseRunManifest(mid, "2026-09-23T13:00:00.000Z");
    expect(done.finalised_at).toBe("2026-09-23T13:00:00.000Z");
  });
});

describe("runManifest store integration", () => {
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-manifest-home-"));
    clearNamedSecretsForTests();
  });

  afterEach(() => {
    clearNamedSecretsForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("persists partial manifest while running and finalises at terminal", async () => {
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const secret = "store-secret-token-xx";
    const manifest = buildInitialRunManifest({
      runId: "will-overwrite",
      createdAt: new Date().toISOString(),
      callerId: "default",
      surface: "rest",
      binding: { kind: "checkout", worktree_path: "/tmp/co" },
      pipelineSource: "inline",
      pipelineBody: JSON.stringify({ id: "p", stages: [], leak: secret }),
      taskYaml: "id: t\ngoal: g\n",
      stages,
      toolchain: [],
      namedSecrets: [{ name: "LEAK", value: secret }],
    });
    const created = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: linearCompatDagSnapshot(["implement"]),
      runManifest: manifest,
    });
    await store.updateRunStatus(created.runId, "running");

    const meta = await store.readRunMeta(created.runId);
    expect(meta.status).toBe("running");
    const stored = parseRunManifest(meta.run_manifest) as RunManifestV1;
    expect(stored.manifest_version).toBe(1);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.finalised_at).toBeUndefined();

    const detail = await store.readRun(created.runId);
    expect(detail.run_manifest).toBeTruthy();
    expect(JSON.stringify(detail.run_manifest)).not.toContain(secret);

    await patchRunManifest(store, created.runId, (m) =>
      withStageResolvedModel(m, "implement", {
        model: "claude-sonnet-4-20250514",
      }),
    );
    const mid = parseRunManifest(
      (await store.readRunMeta(created.runId)).run_manifest,
    ) as RunManifestV1;
    expect(mid.stages[0]?.model.resolved).toBe("claude-sonnet-4-20250514");

    await store.updateRunStatus(created.runId, "succeeded");
    await finaliseStoredRunManifest(store, created.runId);
    const done = parseRunManifest(
      (await store.readRunMeta(created.runId)).run_manifest,
    ) as RunManifestV1;
    expect(done.finalised_at).toBeTruthy();
  });

  it("redactRunManifest strips known secret values from nested fields", () => {
    const secret = "nested-secret-value-xx";
    const raw = {
      manifest_version: 1 as const,
      run_id: "r",
      created_at: "t",
      host: {
        stageflow_version: "0",
        build_sha: "x",
        image_digest: null,
        schema_version: 1,
      },
      caller: { caller_id: null, surface: "cli" as const },
      binding: { kind: "unbound" as const },
      pipeline: {
        source: "inline" as const,
        path: null,
        bytes_sha256: "a",
        body: { token: secret },
      },
      task: {
        source: "inline" as const,
        path: null,
        bytes_sha256: "b",
        body: "ok",
      },
      skills: [],
      stages: [],
      toolchain: [],
    };
    const scrubbed = redactRunManifest(raw, {
      namedSecrets: [{ name: "T", value: secret }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
  });
});
