import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { EngineError } from "./errors.js";
import { engineDir, engineRoot, locatePromptfoo, type EngineMarker } from "./locate.js";
import { assertNode } from "./nodeVersion.js";
import {
  ENGINE_INSTALL_COMMAND,
  ENGINE_MARKER_FILE,
  PINNED_PROMPTFOO_VERSION,
} from "./pinned.js";

export type RunNpm = (
  args: string[],
  opts: { cwd: string; log: (line: string) => void },
) => Promise<{ code: number }>;

export type InstallResult = {
  status: "installed" | "already_installed";
  version: string;
  dir: string;
};

export const realRunNpm: RunNpm = (args, { cwd, log }) =>
  new Promise((resolve, reject) => {
    const nodeDir = path.dirname(process.execPath);
    const npm = path.join(nodeDir, process.platform === "win32" ? "npm.cmd" : "npm");
    const child = spawn(npm, args, {
      cwd,
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", log);
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });

function readIntegrity(dir: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: string }>;
    };
    return lock.packages?.["node_modules/promptfoo"]?.integrity ?? null;
  } catch {
    return null;
  }
}

export async function installPromptfoo(opts: {
  home: string;
  runNpm?: RunNpm;
  log?: (line: string) => void;
}): Promise<InstallResult> {
  const log = opts.log ?? (() => {});
  const runNpm = opts.runNpm ?? realRunNpm;
  assertNode();

  const dir = engineDir(opts.home);
  const existing = locatePromptfoo({ home: opts.home });
  if (existing.installed) {
    log(`promptfoo ${existing.version} is already installed`);
    return { status: "already_installed", version: existing.version, dir };
  }

  const root = engineRoot(opts.home);
  const rootExisted = existsSync(root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "stageflow-eval-engine", private: true }, null, 2)}\n`,
    );
    const { code } = await runNpm(
      ["install", "--no-audit", "--no-fund", `promptfoo@${PINNED_PROMPTFOO_VERSION}`],
      { cwd: dir, log },
    );
    if (code !== 0) {
      throw new EngineError(
        "EVAL_ENGINE_UNAVAILABLE",
        `npm install promptfoo@${PINNED_PROMPTFOO_VERSION} failed (exit ${code}). Retry with \`${ENGINE_INSTALL_COMMAND}\`.`,
      );
    }
    const marker: EngineMarker = {
      version: PINNED_PROMPTFOO_VERSION,
      node: process.versions.node,
      installedAt: new Date().toISOString(),
      integrity: readIntegrity(dir),
    };
    writeFileSync(path.join(dir, ENGINE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    const verified = locatePromptfoo({ home: opts.home });
    if (!verified.installed) {
      throw new EngineError("EVAL_ENGINE_UNAVAILABLE", verified.reason);
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (!rootExisted) rmSync(root, { recursive: true, force: true });
    throw err;
  }
  log(`installed promptfoo ${PINNED_PROMPTFOO_VERSION}`);
  return { status: "installed", version: PINNED_PROMPTFOO_VERSION, dir };
}
