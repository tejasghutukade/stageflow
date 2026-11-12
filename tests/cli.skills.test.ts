import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSkillDoctorProcessEnv,
  createStoredZip,
  runSkillsCommand,
  SKILLS_USAGE,
} from "../src/cli/skillsCommand.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const skillSource = path.join(root, "tests", "fixtures", "skills", "test-skill-source");

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

describe("sf skills", () => {
  it("skills list on empty .pi/skills/ prints nothing", async () => {
    const repo = await initTempGitRepo();
    const lines: string[] = [];
    try {
      const code = await runSkillsCommand(["list"], {
        cwd: repo.root,
        projectRoot: repo.root,
        io: { log: (line) => lines.push(line), error: () => undefined },
      });
      expect(code).toBe(0);
      expect(lines).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-path copies files and excludes node_modules", async () => {
    const repo = await initTempGitRepo();
    const logs: string[] = [];
    const errors: string[] = [];
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: (line) => logs.push(line),
            error: (line) => errors.push(line),
          },
        },
      );
      expect(code).toBe(0);
      expect(logs.some((line) => line.includes("Installed skill test-skill"))).toBe(true);
      expect(errors.join("\n")).not.toMatch(/about to run/);

      const installedRoot = path.join(repo.root, ".pi", "skills", "test-skill");
      await access(path.join(installedRoot, "bin", "test-skill.mjs"));
      await access(path.join(installedRoot, "keep.txt"));
      await expect(
        access(path.join(installedRoot, "node_modules", "pkg", "index.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(path.join(installedRoot, "test", "should-not-copy.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(path.join(installedRoot, "scripts", "generate-docs.sh")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await repo.cleanup();
    }
  });

  it("does not install symbolic links from a skill", async () => {
    const repo = await initTempGitRepo();
    const source = await mkdtemp(path.join(tmpdir(), "sf-skill-links-"));
    const errors: string[] = [];
    try {
      await mkdir(path.join(source, "references"), { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "---\nname: linky\ndescription: x\n---\n");
      await writeFile(path.join(source, "references", "real.md"), "ok");
      await symlink("../../../.env", path.join(source, "references", "secrets.md"));
      const code = await runSkillsCommand(["install", "--from-path", source, "--skill-name", "linky"], {
        cwd: repo.root,
        projectRoot: repo.root,
        io: { log: () => undefined, error: (line) => errors.push(line) },
      });
      expect(code).toBe(0);
      const installed = path.join(repo.root, ".pi", "skills", "linky", "references");
      await access(path.join(installed, "real.md"));
      await expect(lstat(path.join(installed, "secrets.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(errors.join("\n")).toContain("Skipped symbolic links in the skill (not installed): references/secrets.md");
    } finally {
      await rm(source, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("rejects a skill name that escapes the skills directory and does not run its script", async () => {
    const repo = await initTempGitRepo();
    const errors: string[] = [];
    let doctorCalls = 0;
    const keep = path.join(repo.root, "KEEP");
    await writeFile(keep, "safe", "utf8");
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "../.."],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: (line) => errors.push(line),
            runDoctor: () => {
              doctorCalls += 1;
              return 0;
            },
          },
        },
      );
      expect(code).toBe(1);
      expect(doctorCalls).toBe(0);
      expect(errors.join("\n")).toMatch(/invalid skill name/);
      expect(errors.join("\n")).not.toMatch(/about to run/);
      expect(await readFile(keep, "utf8")).toBe("safe");
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses a destination whose real path leaves the skills directory", async () => {
    const repo = await initTempGitRepo();
    const outside = await mkdtemp(path.join(tmpdir(), "sf-skill-outside-"));
    const errors: string[] = [];
    let doctorCalls = 0;
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const skillsDir = path.join(repo.root, ".pi", "skills");
    await mkdir(skillsDir, { recursive: true });
    const link = path.join(skillsDir, "linked");
    await symlink(outside, link);
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "linked"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: (line) => errors.push(line),
            runDoctor: () => {
              doctorCalls += 1;
              return 0;
            },
          },
        },
      );
      expect(code).toBe(1);
      expect(doctorCalls).toBe(0);
      expect(errors.join("\n")).toMatch(/escapes the skills directory/);
      expect(errors.join("\n")).not.toMatch(/about to run/);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-path on missing source exits 1", async () => {
    const repo = await initTempGitRepo();
    const errors: string[] = [];
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", path.join(repo.root, "missing-skill"), "--skill-name", "test-skill"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: { log: () => undefined, error: (line) => errors.push(line) },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/source path not found/);
    } finally {
      await repo.cleanup();
    }
  });

  it("doctor failure exits 1 with skill doctor failed", async () => {
    const repo = await initTempGitRepo();
    const errors: string[] = [];
    try {
      const code = await runSkillsCommand(
        [
          "install",
          "--from-path",
          skillSource,
          "--skill-name",
          "test-skill",
          "--run-doctor",
        ],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: (line) => errors.push(line),
            runDoctor: () => 1,
          },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/skill doctor failed/);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install succeeds without doctor when bin entrypoint is missing", async () => {
    const repo = await initTempGitRepo();
    const mdOnly = path.join(root, "tests", "fixtures", "skills", "md-only-skill");
    let doctorCalls = 0;
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", mdOnly, "--skill-name", "md-only-skill"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: () => undefined,
            runDoctor: () => {
              doctorCalls += 1;
              return 1;
            },
          },
        },
      );
      expect(code).toBe(0);
      expect(doctorCalls).toBe(0);
      await access(path.join(repo.root, ".pi", "skills", "md-only-skill", "SKILL.md"));
    } finally {
      await repo.cleanup();
    }
  });
  it("second install from same source is idempotent", async () => {
    const repo = await initTempGitRepo();
    try {
      const first = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
        { cwd: repo.root, projectRoot: repo.root },
      );
      expect(first).toBe(0);

      const marker = path.join(repo.root, ".pi", "skills", "test-skill", "marker.txt");
      await writeFile(marker, "stale", "utf8");

      const second = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
        { cwd: repo.root, projectRoot: repo.root },
      );
      expect(second).toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await access(path.join(repo.root, ".pi", "skills", "test-skill", "keep.txt"));
    } finally {
      await repo.cleanup();
    }
  });

  it("skills list shows installed skill with version and entry", async () => {
    const repo = await initTempGitRepo();
    const lines: string[] = [];
    try {
      await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
        { cwd: repo.root, projectRoot: repo.root },
      );
      const code = await runSkillsCommand(["list"], {
        cwd: repo.root,
        projectRoot: repo.root,
        io: { log: (line) => lines.push(line), error: () => undefined },
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["test-skill\t1.2.3\tbin/test-skill.mjs"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip with nested skill root extracts correctly", async () => {
    const repo = await initTempGitRepo();
    const zipDir = path.join(repo.root, "zips");
    await mkdir(zipDir, { recursive: true });
    const doctorScript = `#!/usr/bin/env node
if (process.argv[2] === "doctor") process.exit(0);
process.exit(1);
`;
    const zipPath = path.join(zipDir, "nested-skill.zip");
    const zipBytes = createStoredZip([
      { name: "wrapper/nested-skill/bin/nested-skill.mjs", content: doctorScript },
      { name: "wrapper/nested-skill/keep.txt", content: "nested" },
    ]);
    await writeFile(zipPath, zipBytes);

    try {
      const code = await runSkillsCommand(
        ["install", "--from-zip", zipPath, "--skill-name", "nested-skill"],
        { cwd: repo.root, projectRoot: repo.root },
      );
      expect(code).toBe(0);
      const keep = await readFile(
        path.join(repo.root, ".pi", "skills", "nested-skill", "keep.txt"),
        "utf8",
      );
      expect(keep).toBe("nested");
      await access(
        path.join(repo.root, ".pi", "skills", "nested-skill", "bin", "nested-skill.mjs"),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip with local zip extracts correctly", async () => {
    const repo = await initTempGitRepo();
    const zipDir = path.join(repo.root, "zips");
    await mkdir(zipDir, { recursive: true });
    const doctorScript = `#!/usr/bin/env node
if (process.argv[2] === "doctor") process.exit(0);
process.exit(1);
`;
    const zipPath = path.join(zipDir, "zip-skill.zip");
    const zipBytes = createStoredZip([
      { name: "bin/zip-skill.mjs", content: doctorScript },
      { name: "keep.txt", content: "from-zip" },
    ]);
    await writeFile(zipPath, zipBytes);

    try {
      const code = await runSkillsCommand(
        ["install", "--from-zip", zipPath, "--skill-name", "zip-skill"],
        { cwd: repo.root, projectRoot: repo.root },
      );
      expect(code).toBe(0);
      const keep = await readFile(
        path.join(repo.root, ".pi", "skills", "zip-skill", "keep.txt"),
        "utf8",
      );
      expect(keep).toBe("from-zip");
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip rejects zip-slip entries", async () => {
    const repo = await initTempGitRepo();
    const zipDir = path.join(repo.root, "zips");
    await mkdir(zipDir, { recursive: true });
    const zipPath = path.join(zipDir, "evil.zip");
    const zipBytes = createStoredZip([
      { name: "../escape.txt", content: "nope" },
    ]);
    await writeFile(zipPath, zipBytes);
    const errors: string[] = [];

    try {
      const code = await runSkillsCommand(
        ["install", "--from-zip", zipPath, "--skill-name", "evil-skill"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: { log: () => undefined, error: (line) => errors.push(line) },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/zip-slip/);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip --checksum fails on digest mismatch", async () => {
    const repo = await initTempGitRepo();
    const zipDir = path.join(repo.root, "zips");
    await mkdir(zipDir, { recursive: true });
    const zipPath = path.join(zipDir, "checked.zip");
    const zipBytes = createStoredZip([
      { name: "bin/checked-skill.mjs", content: "#!/usr/bin/env node\nprocess.exit(0);\n" },
    ]);
    await writeFile(zipPath, zipBytes);
    const errors: string[] = [];

    try {
      const code = await runSkillsCommand(
        [
          "install",
          "--from-zip",
          zipPath,
          "--skill-name",
          "checked-skill",
          "--checksum",
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: (line) => errors.push(line),
            runDoctor: () => 0,
          },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/checksum mismatch/);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip accepts matching checksum", async () => {
    const repo = await initTempGitRepo();
    const zipDir = path.join(repo.root, "zips");
    await mkdir(zipDir, { recursive: true });
    const zipPath = path.join(zipDir, "checked-ok.zip");
    const zipBytes = createStoredZip([
      {
        name: "bin/checked-ok.mjs",
        content: "#!/usr/bin/env node\nif (process.argv[2]==='doctor') process.exit(0); process.exit(1);\n",
      },
    ]);
    await writeFile(zipPath, zipBytes);
    const digest = createHash("sha256").update(zipBytes).digest("hex");

    try {
      const code = await runSkillsCommand(
        [
          "install",
          "--from-zip",
          zipPath,
          "--skill-name",
          "checked-ok",
          "--checksum",
          `sha256:${digest}`,
        ],
        { cwd: repo.root, projectRoot: repo.root },
      );
      expect(code).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills install --from-zip rejects http URLs", async () => {
    const repo = await initTempGitRepo();
    const errors: string[] = [];
    try {
      const code = await runSkillsCommand(
        ["install", "--from-zip", "http://example.com/skill.zip", "--skill-name", "remote"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: { log: () => undefined, error: (line) => errors.push(line) },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/only HTTPS URLs are supported/);
    } finally {
      await repo.cleanup();
    }
  });

  it("skills --help prints usage", { timeout: 15_000 }, () => {
    const repoDir = root;
    const result = runCli(["skills", "--help"], repoDir);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf skills list/);
    expect(out).toMatch(/--from-path/);
    expect(out).toMatch(/--from-zip/);
    expect(out).toMatch(SKILLS_USAGE.slice(0, 20));
  });

  it("top-level --help mentions sf skills", { timeout: 15_000 }, () => {
    const result = runCli(["--help"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf skills list/);
    expect(result.stdout).toMatch(/--from-path/);
  });

  it("does not run doctor without --run-doctor when stdin is not a TTY", async () => {
    const repo = await initTempGitRepo();
    let doctorCalls = 0;
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: () => undefined,
            stdinIsTTY: false,
            runDoctor: () => {
              doctorCalls += 1;
              return 0;
            },
          },
        },
      );
      expect(code).toBe(0);
      expect(doctorCalls).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("--run-doctor uses stage allowlist env without control token or provider key", async () => {
    const repo = await initTempGitRepo();
    const probeRoot = await mkdtemp(path.join(tmpdir(), "sf-skill-doctor-env-"));
    const probe = path.join(probeRoot, "env.json");
    const skillTree = await mkdtemp(path.join(tmpdir(), "sf-skill-doctor-src-"));
    const script = `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] !== "doctor") process.exit(1);
fs.writeFileSync(process.env.SF_DOCTOR_PROBE, JSON.stringify({
  control: process.env.STAGEFLOW_CONTROL_TOKEN,
  openai: process.env.OPENAI_API_KEY,
}));
process.exit(0);
`;
    await mkdir(path.join(skillTree, "bin"), { recursive: true });
    await writeFile(path.join(skillTree, "bin", "probe-skill.mjs"), script, "utf8");
    await writeFile(path.join(skillTree, "SKILL.md"), "# probe\n", "utf8");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const errors: string[] = [];
    try {
      const code = await runSkillsCommand(
        [
          "install",
          "--from-path",
          skillTree,
          "--skill-name",
          "probe-skill",
          "--run-doctor",
        ],
        {
          cwd: repo.root,
          projectRoot: repo.root,
          io: {
            log: () => undefined,
            error: (line) => errors.push(line),
            stdinIsTTY: false,
            hostEnv: {
              PATH: process.env.PATH,
              STAGEFLOW_CONTROL_TOKEN: "a".repeat(64),
              OPENAI_API_KEY: "sk-test",
              SF_DOCTOR_PROBE: probe,
            },
            runDoctor: (scriptPath, cwd, hostEnv) => {
              capturedEnv = hostEnv;
              const result = spawnSync(process.execPath, [scriptPath, "doctor"], {
                cwd,
                env: { ...buildSkillDoctorProcessEnv(hostEnv), SF_DOCTOR_PROBE: probe },
              });
              if (result.status !== 0) {
                errors.push(result.stderr?.toString() ?? "doctor exited non-zero");
              }
              return result.status ?? 1;
            },
          },
        },
      );
      expect(errors, `exit ${code}`).toEqual([]);
      expect(code).toBe(0);
      expect(capturedEnv?.STAGEFLOW_CONTROL_TOKEN).toBe("a".repeat(64));
      const written = JSON.parse(await readFile(probe, "utf8")) as {
        control?: string;
        openai?: string;
      };
      expect(written.control).toBeUndefined();
      expect(written.openai).toBeUndefined();
    } finally {
      await repo.cleanup();
      await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(skillTree, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("drops symlinks instead of copying or following them", async () => {
    const repo = await initTempGitRepo();
    const src = await mkdtemp(path.join(tmpdir(), "sf-skill-symlink-src-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sf-skill-symlink-out-"));
    await writeFile(path.join(outside, "secret.txt"), "leaked", "utf8");
    await mkdir(path.join(src, "bin"), { recursive: true });
    await writeFile(
      path.join(src, "bin", "link-skill.mjs"),
      `#!/usr/bin/env node\nif (process.argv[2]==='doctor') process.exit(0); process.exit(1);\n`,
      "utf8",
    );
    await writeFile(path.join(src, "SKILL.md"), "# link\n", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(src, "leak.txt"));
    try {
      const code = await runSkillsCommand(
        ["install", "--from-path", src, "--skill-name", "link-skill"],
        { cwd: repo.root, projectRoot: repo.root, io: { stdinIsTTY: false } },
      );
      expect(code).toBe(0);
      const installed = path.join(repo.root, ".pi", "skills", "link-skill", "leak.txt");
      const installedRoot = path.join(repo.root, ".pi", "skills", "link-skill");
      await expect(lstat(installed)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("leaked");
      await expect(access(path.join(installedRoot, "secret.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await repo.cleanup();
      await rm(src, { recursive: true, force: true }).catch(() => undefined);
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("running an installed skill's doctor", () => {
  it("runs the installed script without reinstalling, and 404s or 400s when it cannot", async () => {
    const { runInstalledSkillDoctor } = await import("../src/cli/skillsCommand.js");
    const repo = await initTempGitRepo();
    const source = await mkdtemp(path.join(tmpdir(), "sf-skill-doctor-src-"));
    try {
      await mkdir(path.join(source, "bin"), { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "---\nname: doc-skill\ndescription: x\n---\n");
      await writeFile(path.join(source, "bin", "doc-skill.mjs"), "process.exit(0);\n");
      expect(
        await runSkillsCommand(["install", "--from-path", source, "--skill-name", "doc-skill"], {
          cwd: repo.root,
          projectRoot: repo.root,
          io: { log: () => undefined, error: () => undefined, stdinIsTTY: false },
        }),
      ).toBe(0);
      // Change the source after install: the doctor must run the installed copy, not refetch.
      await writeFile(path.join(source, "bin", "doc-skill.mjs"), "process.exit(9);\n");
      const ranScripts: string[] = [];
      const ran = await runInstalledSkillDoctor({
        projectRoot: repo.root,
        skillName: "doc-skill",
        run: (script) => {
          ranScripts.push(script);
          return 0;
        },
      });
      expect(ran).toEqual({ ok: true, script: "bin/doc-skill.mjs" });
      expect(ranScripts[0]).toContain(path.join(".pi", "skills", "doc-skill", "bin", "doc-skill.mjs"));

      expect(await runInstalledSkillDoctor({ projectRoot: repo.root, skillName: "missing-skill", run: () => 0 })).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(await runInstalledSkillDoctor({ projectRoot: repo.root, skillName: "../escape", run: () => 0 })).toMatchObject({
        ok: false,
        status: 400,
      });
    } finally {
      await rm(source, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("gives the doctor script an empty temporary HOME", async () => {
    const { runSkillDoctorScript } = await import("../src/cli/skillsCommand.js");
    const dir = await mkdtemp(path.join(tmpdir(), "sf-doctor-home-"));
    try {
      const out = path.join(dir, "home.txt");
      const script = path.join(dir, "doctor.mjs");
      await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, process.env.HOME ?? "");\n`);
      expect(runSkillDoctorScript(script, dir, { ...process.env, HOME: "/Users/someone" })).toBe(0);
      const seen = await readFile(out, "utf8");
      expect(seen).not.toBe("/Users/someone");
      expect(seen).toContain("sf-skill-doctor-home-");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
