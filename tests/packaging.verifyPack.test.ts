import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const verifyScript = path.join(root, "scripts", "verify-pack.ts");
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

describe("packaging verify-pack", () => {
  it("exits 0 when dist/cli.js and dist/ui/index.html exist", async () => {
    if (!(await exists(distCli)) || !(await exists(distUiIndex))) {
      console.log("skip: dist/cli.js or dist/ui/index.html missing");
      return;
    }

    const result = spawnSync(process.execPath, [tsxCli, verifyScript], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/verify-pack ok/);
  });
});
