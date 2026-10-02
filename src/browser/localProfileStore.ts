import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  type ProfileHandle,
  type ProfileKey,
  type ProfileStore,
  validateProfileKey,
  validateProfileScope,
} from "./profileStore.js";

function browserRoot(): string {
  return path.join(globalStageflowHome(), "browser");
}

function scopeDir(scope: string): string {
  return path.join(browserRoot(), scope);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export function createLocalProfileStore(): ProfileStore {
  return {
    async open(rawKey: ProfileKey): Promise<ProfileHandle> {
      const key = validateProfileKey(rawKey);
      const base = path.join(scopeDir(key.scope), key.name);
      const profileDir = path.join(base, "profile");
      const stateDir = path.join(base, "state");
      await ensurePrivateDir(browserRoot());
      await ensurePrivateDir(scopeDir(key.scope));
      await ensurePrivateDir(base);
      await ensurePrivateDir(profileDir);
      await ensurePrivateDir(stateDir);
      return { key, profileDir, stateDir };
    },

    async list(scope: string): Promise<string[]> {
      const dir = scopeDir(validateProfileScope(scope));
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },

    async delete(rawKey: ProfileKey): Promise<void> {
      const key = validateProfileKey(rawKey);
      await rm(path.join(scopeDir(key.scope), key.name), {
        recursive: true,
        force: true,
      });
    },

    async deleteScope(scope: string): Promise<void> {
      await rm(scopeDir(validateProfileScope(scope)), {
        recursive: true,
        force: true,
      });
    },
  };
}
