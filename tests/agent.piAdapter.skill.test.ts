import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeStageUserPrompt,
  createSealedResourceLoader,
  createStageSessionManager,
  PiAgentAdapter,
  reconstructStageSessionForAnswer,
  StageSessionReconstructError,
} from "../src/agent/piAdapter.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";

async function writeSkill(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function sealedLoader(options: {
  cwd: string;
  agentDir: string;
  additionalSkillPaths?: string[];
}) {
  const loader = createSealedResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPrompt: "sealed",
    additionalSkillPaths: options.additionalSkillPaths,
  });
  await loader.reload();
  return loader;
}

describe("sealed skill inject", () => {
  it("loads only the named skill when the operator catalog has two", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-skill-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-skill-agent-"));
    const namedPath = await writeSkill(
      path.join(agentDir, "skills"),
      "named-skill",
      "---\nname: named-skill\ndescription: The one to inject.\n---\n# Named\n",
    );
    await writeSkill(
      path.join(agentDir, "skills"),
      "other-skill",
      "---\nname: other-skill\ndescription: Must stay sealed out.\n---\n# Other\n",
    );

    const loader = await sealedLoader({
      cwd,
      agentDir,
      additionalSkillPaths: [namedPath],
    });
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(["named-skill"]);
  });

  it("loads no skills when the stage does not name one", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-skill-empty-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-skill-empty-agent-"));
    await writeSkill(
      path.join(agentDir, "skills"),
      "other-skill",
      "---\nname: other-skill\ndescription: Must stay sealed out.\n---\n# Other\n",
    );

    const loader = await sealedLoader({ cwd, agentDir });
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("still injects a command-only skill", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-skill-cmd-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-skill-cmd-agent-"));
    const filePath = await writeSkill(
      path.join(agentDir, "skills"),
      "cmd-only",
      "---\nname: cmd-only\ndescription: Command only.\ndisable-model-invocation: true\n---\n# Cmd\n",
    );

    const loader = await sealedLoader({
      cwd,
      agentDir,
      additionalSkillPaths: [filePath],
    });
    expect(loader.getSkills().skills).toEqual([
      expect.objectContaining({
        name: "cmd-only",
        disableModelInvocation: true,
      }),
    ]);
  });

  it("fails before prompt when a named skill has no resolved path", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-skill-miss-"));
    const adapter = new PiAgentAdapter();
    const result = await adapter.runStage({
      roots: buildStageRoots(runWs, "clarify"),
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
        skill: "missing-skill",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("missing-skill"),
    });
  });

  it("fails reconstruct prepare when the named skill is missing", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-skill-recon-"));
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "start",
      timestamp: Date.now(),
    });
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_wait_1",
          name: "ask_operator",
          arguments: { prompt: "need approval" },
        },
      ],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });

    await expect(
      reconstructStageSessionForAnswer(
        {
          roots,
          stage: {
            id: "clarify",
            system_prompt: "x",
            model: "anthropic/claude-sonnet-4-5",
            skill: "gone-skill",
          },
          task: { id: "t", goal: "g" },
          priorEnvelope: null,
        },
        { text: "approved" },
      ),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof StageSessionReconstructError &&
        err.message.includes("gone-skill"),
    );
  });
});

describe("stage skill invoke prefix", () => {
  it("starts named-skill prompts with /skill:name then a space", () => {
    const runWs = "/tmp/run-ws";
    const checkout = "/tmp/checkout";
    const skillFilePath = "/tmp/skills/improve-codebase-architecture/SKILL.md";
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots(runWs, "review", checkout),
        stage: {
          id: "review",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
          skill: "improve-codebase-architecture",
        },
        task: { id: "t1", goal: "Review the diff" },
        priorEnvelope: null,
        skillFilePath,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );

    expect(prompt.startsWith("/skill:improve-codebase-architecture ")).toBe(true);
    expect(prompt[("/skill:improve-codebase-architecture").length]).toBe(" ");
    expect(prompt.includes("\n") && prompt.startsWith("/skill:improve-codebase-architecture\n")).toBe(false);
    expect(prompt).toContain("Task id: t1");
    expect(prompt).toContain("Goal: Review the diff");
    expect(prompt).toContain("emit_stage_envelope");
    expect(prompt).toContain(path.dirname(skillFilePath));
  });

  it("does not prefix unnamed stages and keeps checkout-only bound wording", () => {
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout"),
        stage: {
          id: "clarify",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "Clarify the work" },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );

    expect(prompt).not.toContain("/skill:");
    expect(prompt).toContain("Task id: t1");
    expect(prompt).toContain("Builtin tools (read, bash, write, edit) are for work inside the project checkout.");
    expect(prompt).not.toContain("linked skill");
    expect(prompt).toContain("stages/clarify/attempts/1/artifacts/");
    expect(prompt).not.toContain("path relative to stages/clarify/artifacts/");
    expect(prompt).not.toContain(
      "Write any artifacts under stages/clarify/artifacts/",
    );
  });

  it("unbound prompt prefers write_stage_artifact under attempt artifacts", () => {
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots("/tmp/run-ws", "hamilton-weather"),
        stage: {
          id: "hamilton-weather",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "Fetch weather" },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );

    expect(prompt).toContain("stages/hamilton-weather/attempts/1/artifacts/");
    expect(prompt).toContain("write_stage_artifact");
    expect(prompt).toContain("prefer write_stage_artifact");
    expect(prompt).not.toContain("Project checkout (agent cwd):");
    expect(prompt).not.toContain(
      "Write any artifacts under stages/hamilton-weather/artifacts/",
    );
  });

  it("bound and unbound prompts cite attempt from roots", () => {
    const unbound = composeStageUserPrompt(
      {
        roots: {
          ...buildStageRoots("/tmp/run-ws", "clarify"),
          attempt: 2,
        },
        stage: {
          id: "clarify",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "Retry" },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );
    const bound = composeStageUserPrompt(
      {
        roots: {
          ...buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout"),
          attempt: 3,
        },
        stage: {
          id: "clarify",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "Retry" },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );

    expect(unbound).toContain("stages/clarify/attempts/2/artifacts/");
    expect(bound).toContain("stages/clarify/attempts/3/artifacts/");
  });

  it("uses instance stageId for prompt identity and artifact path", () => {
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots("/tmp/run-ws", "work~2"),
        stage: {
          id: "work",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        stageId: "work~2",
        task: { id: "t1", goal: "Fan out a clone" },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );

    expect(prompt).toContain("Stage id: work~2");
    expect(prompt).toContain("stages/work~2/attempts/1/artifacts/");
    expect(prompt).not.toContain("Stage id: work\n");
    expect(prompt).not.toContain("stages/work/attempts/");
  });
});
