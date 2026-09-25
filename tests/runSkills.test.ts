import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { START_PAYLOAD_MAX_BYTES } from "../src/runtime/startPayload.js";
import {
  SKILLS_INVALID_NAME,
  SKILLS_INVALID_PATH,
  SKILLS_MISSING_SKILL_MD,
  SKILLS_PAYLOAD_TOO_LARGE,
  materializeRunSkills,
  runSkillsDir,
  validateSkillsPayload,
} from "../src/runtime/runSkills.js";

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

describe("validateSkillsPayload", () => {
  it("accepts a map with SKILL.md and measures bytes", () => {
    const body = skillMd("archify", "Archify skill.");
    const result = validateSkillsPayload({
      archify: { "SKILL.md": body },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(result.skills.archify?.["SKILL.md"]).toBe(body);
  });

  it("rejects absolute and .. skill names", () => {
    expect(
      validateSkillsPayload({
        "/abs": { "SKILL.md": skillMd("x", "d") },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_NAME });
    expect(
      validateSkillsPayload({
        "..": { "SKILL.md": skillMd("x", "d") },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_NAME });
    expect(
      validateSkillsPayload({
        "a/b": { "SKILL.md": skillMd("x", "d") },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_NAME });
    expect(
      validateSkillsPayload({
        "a\\b": { "SKILL.md": skillMd("x", "d") },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_NAME });
    expect(
      validateSkillsPayload({
        "nul\0name": { "SKILL.md": skillMd("x", "d") },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_NAME });
  });

  it("rejects absolute and .. file paths", () => {
    expect(
      validateSkillsPayload({
        archify: {
          "SKILL.md": skillMd("archify", "d"),
          "/etc/passwd": "x",
        },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_PATH });
    expect(
      validateSkillsPayload({
        archify: {
          "SKILL.md": skillMd("archify", "d"),
          "../escape.md": "x",
        },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_INVALID_PATH });
  });

  it("rejects missing SKILL.md", () => {
    expect(
      validateSkillsPayload({
        archify: { "scripts/run.sh": "echo hi" },
      }),
    ).toMatchObject({ ok: false, code: SKILLS_MISSING_SKILL_MD });
  });

  it("rejects when pipeline + skills exceed START_PAYLOAD_MAX_BYTES", () => {
    const pad = "x".repeat(START_PAYLOAD_MAX_BYTES);
    const result = validateSkillsPayload(
      { archify: { "SKILL.md": skillMd("archify", "d") } },
      { pipelineBytes: Buffer.byteLength(pad, "utf8") },
    );
    expect(result).toMatchObject({
      ok: false,
      code: SKILLS_PAYLOAD_TOO_LARGE,
    });
  });
});

describe("materializeRunSkills", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes under workspace/skills/<name>/ and contains realpaths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "sf-run-skills-"));
    dirs.push(workspace);
    const body = skillMd("archify", "Run skill.");
    await materializeRunSkills(workspace, {
      archify: {
        "SKILL.md": body,
        "scripts/helper.sh": "#!/bin/sh\necho ok\n",
      },
    });
    const skillFile = path.join(
      runSkillsDir(workspace),
      "archify",
      "SKILL.md",
    );
    expect(await readFile(skillFile, "utf8")).toBe(body);
    const helper = path.join(
      runSkillsDir(workspace),
      "archify",
      "scripts",
      "helper.sh",
    );
    await access(helper);
    const skillsReal = await realpath(runSkillsDir(workspace));
    const fileReal = await realpath(skillFile);
    expect(fileReal.startsWith(skillsReal + path.sep)).toBe(true);
  });
});
