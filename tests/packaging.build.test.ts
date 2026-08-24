import { access, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const copyScript = path.join(root, "scripts", "copy-ui-dist.ts");
const uiIndex = path.join(root, "ui", "dist", "index.html");
const distUiIndex = path.join(root, "dist", "ui", "index.html");
const distUiAssets = path.join(root, "dist", "ui", "assets");

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("packaging build copy", () => {
  it("copies ui/dist into dist/ui idempotently when UI is built", async () => {
    if (!(await exists(uiIndex))) {
      console.log("skip: ui/dist/index.html missing (UI not built)");
      return;
    }

    const runCopy = () =>
      spawnSync(process.execPath, [tsxCli, copyScript], {
        cwd: root,
        encoding: "utf8",
      });

    const first = runCopy();
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(await exists(distUiIndex)).toBe(true);

    const second = runCopy();
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(await exists(distUiIndex)).toBe(true);

    if (await exists(distUiAssets)) {
      const assets = await readdir(distUiAssets);
      expect(assets.length).toBeGreaterThan(0);
    }
  });
});
