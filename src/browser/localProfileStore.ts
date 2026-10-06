import { access, chmod, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import { type AuditSink, createLocalAuditSink, safeAudit } from "./auditSink.js";
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function createLocalProfileStore(
  options: { audit?: AuditSink } = {},
): ProfileStore {
  const audit = options.audit ?? createLocalAuditSink();
  return {
    async open(rawKey: ProfileKey): Promise<ProfileHandle> {
      const key = validateProfileKey(rawKey);
      const base = path.join(scopeDir(key.scope), key.name);
      const profileDir = path.join(base, "profile");
      const stateDir = path.join(base, "state");
      const created = !(await exists(base));
      await ensurePrivateDir(browserRoot());
      await ensurePrivateDir(scopeDir(key.scope));
      await ensurePrivateDir(base);
      await ensurePrivateDir(profileDir);
      await ensurePrivateDir(stateDir);
      if (created) {
        await safeAudit(audit, {
          event: "profile_created",
          scope: key.scope,
          profile: key.name,
        });
      }
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
      const target = path.join(scopeDir(key.scope), key.name);
      const existed = await exists(target);
      await rm(target, { recursive: true, force: true });
      if (existed) {
        await safeAudit(audit, {
          event: "profile_deleted",
          scope: key.scope,
          profile: key.name,
        });
      }
    },

    async deleteScope(scope: string): Promise<void> {
      const valid = validateProfileScope(scope);
      for (const name of await this.list(valid)) {
        await safeAudit(audit, {
          event: "profile_deleted",
          scope: valid,
          profile: name,
        });
      }
      await rm(scopeDir(valid), {
        recursive: true,
        force: true,
      });
    },
  };
}
