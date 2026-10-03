import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

/**
 * Supplies a Host-held secret for protecting browser state at rest. Not wired
 * to agent-browser: its key only covers its own restore/state files, never the
 * Chrome profile directory.
 */
export interface KeyProvider {
  getKey(): Promise<string>;
}

export function localKeyFilePath(): string {
  return path.join(globalStageflowHome(), "browser", "browser.key");
}

export function createLocalKeyProvider(file?: string): KeyProvider {
  return {
    async getKey() {
      const target = file ?? localKeyFilePath();
      try {
        const existing = (await readFile(target, "utf8")).trim();
        if (existing.length > 0) {
          await chmod(target, 0o600);
          return existing;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const key = randomBytes(32).toString("hex");
      try {
        await writeFile(target, `${key}\n`, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return (await readFile(target, "utf8")).trim();
        }
        throw err;
      }
      return key;
    },
  };
}
