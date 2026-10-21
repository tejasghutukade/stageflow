import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeStageUserPrompt,
  createSealedResourceLoader,
} from "../src/agent/piAdapter.js";
import { resolveBuiltinSkillFile } from "../src/config/builtinSkills.js";
import { resolveSkillByName } from "../src/config/listSkills.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";

const BUNDLED = resolveBuiltinSkillFile("browser");

function input(overrides: Record<string, unknown> = {}) {
  return {
    roots: buildStageRoots("/tmp/run-ws", "work"),
    stage: {
      id: "work",
      system_prompt: "x",
      model: "anthropic/claude-sonnet-4-5",
    },
    task: { id: "t1", goal: "Read the page" },
    priorEnvelope: null,
    ...overrides,
  } as Parameters<typeof composeStageUserPrompt>[0];
}

function prompt(i: Parameters<typeof composeStageUserPrompt>[0]) {
  return composeStageUserPrompt(i, "emit_stage_envelope", undefined, "write_stage_artifact");
}

describe("bundled browser skill", () => {
  it("ships inside the package with the agreed rules", async () => {
    expect(BUNDLED).toBeDefined();
    const text = await readFile(BUNDLED!, "utf8");
    expect(text).toMatch(/^---\nname: browser\ndescription: .+\n---/);
    for (const needle of [
      "agent-browser open",
      "snapshot -i",
      "click @",
      "fill @",
      "press",
      "wait",
      "screenshot",
      "get url",
      "get text",
      "STAGEFLOW_STAGE_ARTIFACTS_DIR",
      "--profile",
      "--session",
      "untrusted",
      "login lost",
      "CAPTCHA",
      "irreversible",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("resolves as a built-in fallback and loses to a host skill of the same name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-bs-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-bs-agent-"));
    const builtin = await resolveSkillByName("browser", { cwd, agentDir });
    expect(builtin?.origin).toBe("builtin");
    expect(builtin?.filePath).toBe(BUNDLED);

    const hostDir = path.join(agentDir, "skills", "browser");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, "SKILL.md"),
      "---\nname: browser\ndescription: Host copy.\n---\n# Host\n",
    );
    const host = await resolveSkillByName("browser", { cwd, agentDir });
    expect(host?.origin).toBe("host");
  });

  it("treats a missing built-in file as not found, not an error", () => {
    expect(
      resolveBuiltinSkillFile("browser", "file:///nowhere/a/b/c.js"),
    ).toBeUndefined();
    expect(resolveBuiltinSkillFile("not-builtin")).toBeUndefined();
  });
});

describe("browser stage prompt", () => {
  const browser = { allow_domains: ["example.com", "*.example.org"] };

  it("gives a browser stage the skill and allowed domains with no skill field", () => {
    const p = prompt(input({
      stage: { id: "work", system_prompt: "x", model: "m", browser },
      browserSkillFilePath: BUNDLED,
    }));
    expect(p.startsWith("/skill:browser ")).toBe(true);
    expect(p).toContain("Allowed domains: example.com, *.example.org");
    expect(p).toContain("agent-browser");
  });

  it("lists domains even when the skill file is missing", () => {
    const p = prompt(input({
      stage: { id: "work", system_prompt: "x", model: "m", browser },
    }));
    expect(p).not.toContain("/skill:");
    expect(p).toContain("Allowed domains: example.com, *.example.org");
  });

  it("gives a stage without browser no browser text", () => {
    const p = prompt(input({ browserSkillFilePath: BUNDLED }));
    expect(p).not.toContain("/skill:");
    expect(p).not.toContain("agent-browser");
    expect(p).not.toContain("Allowed domains");
  });

  it("keeps an explicit skill as the invoked skill and points at the browser skill", () => {
    const p = prompt(input({
      stage: { id: "work", system_prompt: "x", model: "m", skill: "other", browser },
      skillFilePath: "/tmp/skills/other/SKILL.md",
      browserSkillFilePath: BUNDLED,
    }));
    expect(p.startsWith("/skill:other ")).toBe(true);
    expect(p).toContain(`read the browser skill at ${BUNDLED}`);
    expect(p).toContain("Allowed domains: example.com");
  });

  it("loads both skills into the sealed session", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-bs2-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-bs2-agent-"));
    const otherDir = path.join(agentDir, "skills", "other");
    await mkdir(otherDir, { recursive: true });
    const other = path.join(otherDir, "SKILL.md");
    await writeFile(other, "---\nname: other\ndescription: Other.\n---\n# O\n");
    const loader = createSealedResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      systemPrompt: "s",
      additionalSkillPaths: [other, BUNDLED!],
    });
    await loader.reload();
    expect(loader.getSkills().skills.map((s) => s.name).sort()).toEqual([
      "browser",
      "other",
    ]);
  });
});
