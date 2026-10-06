import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
        ["install", "--from-path", skillSource, "--skill-name", "test-skill"],
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
});
