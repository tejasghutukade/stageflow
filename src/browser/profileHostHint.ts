import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfileHandle } from "./profileStore.js";

/** Where a profile's browsing has to happen. Learned by the Host or set in Host config; never in YAML. */
export type ProfileHostMode = "attach";

export type ProfileHostHint = { mode: ProfileHostMode; reason: string; at: string };

export interface ProfileHostHints {
  get(profile: ProfileHandle): Promise<ProfileHostHint | undefined>;
  set(profile: ProfileHandle, hint: { mode: ProfileHostMode; reason: string }): Promise<void>;
  clear(profile: ProfileHandle): Promise<void>;
}

const HINT_FILENAME = "host-hint.json";

/** Hints in the profile's state folder when it has one, else in memory for this process. */
export function createProfileHostHints(): ProfileHostHints {
  const memory = new Map<string, ProfileHostHint>();
  const keyOf = (p: ProfileHandle) => `${p.key.scope}\0${p.key.name}`;
  const fileOf = (p: ProfileHandle) => (p.stateDir !== undefined ? path.join(p.stateDir, HINT_FILENAME) : undefined);

  return {
    async get(profile) {
      const file = fileOf(profile);
      if (file === undefined) return memory.get(keyOf(profile));
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ProfileHostHint>;
        if (parsed.mode === "attach" && typeof parsed.reason === "string" && typeof parsed.at === "string") {
          return { mode: "attach", reason: parsed.reason, at: parsed.at };
        }
      } catch {
        // missing or unreadable: no hint
      }
      return undefined;
    },
    async set(profile, hint) {
      const value: ProfileHostHint = { ...hint, at: new Date().toISOString() };
      const file = fileOf(profile);
      if (file === undefined) {
        memory.set(keyOf(profile), value);
        return;
      }
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    },
    async clear(profile) {
      memory.delete(keyOf(profile));
      const file = fileOf(profile);
      if (file !== undefined) await rm(file, { force: true });
    },
  };
}
