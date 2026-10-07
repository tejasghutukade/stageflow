import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const copyScript = path.join(root, "scripts", "copy-ui-dist.ts");

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function runCopy(packRoot: string) {
  return spawnSync(process.execPath, [tsxCli, copyScript], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, STAGEFLOW_PACK_ROOT: packRoot },
  });
}

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-copy-ui-"));
  tmpRoots.push(dir);
  return dir;
}

describe("packaging build copy", () => {
  it("copies ui/dist into dist/ui idempotently and drops stale files", async () => {
    const dir = await makeRoot();
    await mkdir(path.join(dir, "ui", "dist", "assets"), { recursive: true });
    await writeFile(path.join(dir, "ui", "dist", "index.html"), "<html></html>");
    await writeFile(path.join(dir, "ui", "dist", "assets", "app.js"), "");

    const first = runCopy(dir);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(await readdir(path.join(dir, "dist", "ui", "assets"))).toEqual(["app.js"]);

    await rm(path.join(dir, "ui", "dist", "assets", "app.js"));
    await writeFile(path.join(dir, "ui", "dist", "assets", "app2.js"), "");
    const second = runCopy(dir);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(await exists(path.join(dir, "dist", "ui", "index.html"))).toBe(true);
    expect(await readdir(path.join(dir, "dist", "ui", "assets"))).toEqual(["app2.js"]);
  });

  it("fails with a build hint when ui/dist/index.html is missing", async () => {
    const dir = await makeRoot();
    await mkdir(path.join(dir, "ui", "dist"), { recursive: true });
    const result = runCopy(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no index\.html/);
    expect(result.stderr).toMatch(/npm run ui:build/);
  });
});
