import {
  type ProfileHandle,
  type ProfileKey,
  type ProfileStore,
  validateProfileKey,
  validateProfileScope,
} from "./profileStore.js";

export function createInMemoryProfileStore(): ProfileStore {
  const scopes = new Map<string, Map<string, ProfileHandle>>();

  return {
    async open(rawKey: ProfileKey): Promise<ProfileHandle> {
      const key = validateProfileKey(rawKey);
      let profiles = scopes.get(key.scope);
      if (!profiles) {
        profiles = new Map();
        scopes.set(key.scope, profiles);
      }
      let handle = profiles.get(key.name);
      if (!handle) {
        const base = `memory://${key.scope}/${key.name}`;
        handle = { key, profileDir: `${base}/profile`, stateDir: `${base}/state` };
        profiles.set(key.name, handle);
      }
      return handle;
    },

    async list(scope: string): Promise<string[]> {
      return [...(scopes.get(validateProfileScope(scope))?.keys() ?? [])].sort();
    },

    async delete(rawKey: ProfileKey): Promise<void> {
      const key = validateProfileKey(rawKey);
      scopes.get(key.scope)?.delete(key.name);
    },

    async deleteScope(scope: string): Promise<void> {
      scopes.delete(validateProfileScope(scope));
    },
  };
}
