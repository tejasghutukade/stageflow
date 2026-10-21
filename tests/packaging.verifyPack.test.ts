import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const verifyScript = path.join(root, "scripts", "verify-pack.ts");

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makePackRoot(opts: { dropSkillsFromFiles?: boolean; extra?: Record<string, string> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-verify-pack-"));
  tmpRoots.push(dir);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    files: string[];
    scripts?: unknown;
  };
  delete pkg.scripts;
  if (opts.dropSkillsFromFiles) pkg.files = pkg.files.filter((f) => f !== "skills");
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const files: Record<string, string> = {
    "dist/cli.js": "",
    "dist/ui/index.html": "",
    "skills/stageflow/SKILL.md": "",
    "examples/README.md": "",
    ...opts.extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}

function runVerifyPack(packRoot: string) {
  return spawnSync(process.execPath, [tsxCli, verifyScript], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, STAGEFLOW_PACK_ROOT: packRoot },
  });
}

describe.sequential("packaging verify-pack", () => {
  it("exits 0 when every required path is packed", async () => {
    const result = runVerifyPack(await makePackRoot());
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/verify-pack ok/);
  });

  it("fails verify-pack when skills is removed from package.json files", async () => {
    const result = runVerifyPack(await makePackRoot({ dropSkillsFromFiles: true }));
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/missing required path: skills\/stageflow\/SKILL\.md/);
  });

  it("fails verify-pack when the tarball would ship forbidden paths", async () => {
    const dir = await makePackRoot();
    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { files: string[] };
    pkg.files.push("docs");
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "a.md"), "");
    await writeFile(pkgPath, JSON.stringify(pkg));
    const result = runVerifyPack(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/forbidden path \(docs\/\): docs\/a\.md/);
  });
});
