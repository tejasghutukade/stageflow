import { access } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const verifyScript = path.join(root, "scripts", "verify-pack.ts");
const pkgPath = path.join(root, "package.json");
const distCli = path.join(root, "dist", "cli.js");
const distUiIndex = path.join(root, "dist", "ui", "index.html");

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function runVerifyPack() {
  return spawnSync(process.execPath, [tsxCli, verifyScript], {
    cwd: root,
    encoding: "utf8",
  });
}

describe.sequential("packaging verify-pack", () => {
  it("lists skills in package.json files and verify-pack REQUIRED", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { files: string[] };
    expect(pkg.files).toContain("skills");
    expect(readFileSync(verifyScript, "utf8")).toContain('"skills/stageflow/SKILL.md"');
  });

  it("exits 0 when dist/cli.js and dist/ui/index.html exist", async () => {
    if (!(await exists(distCli)) || !(await exists(distUiIndex))) {
      console.log("skip: dist/cli.js or dist/ui/index.html missing");
      return;
    }

    const result = runVerifyPack();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/verify-pack ok/);
  });

  it("fails verify-pack when skills is removed from package.json files", () => {
    const original = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(original) as { files: string[] };
    if (!pkg.files.includes("skills")) {
      expect(pkg.files).toContain("skills");
      return;
    }

    try {
      writeFileSync(
        pkgPath,
        `${JSON.stringify({ ...pkg, files: pkg.files.filter((f) => f !== "skills") }, null, 2)}\n`,
      );
      const result = runVerifyPack();
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/skills\/stageflow\/SKILL\.md/);
    } finally {
      writeFileSync(pkgPath, original);
    }
  });
});
