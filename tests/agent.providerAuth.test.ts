import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import {
  getAuthStatus,
  listProviders,
  loginWithApiKey,
  logoutProvider,
  makeMutationLock,
  ProviderAuthError,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import { sfOwnedAuthPath } from "../src/runtime/credentialBinding.js";
import { storeRootFor } from "../src/runstore/paths.js";

function fakeProvider(partial: {
  id: string;
  name: string;
  supportsApiKeyLogin?: boolean;
  supportsOauth?: boolean;
}): Provider {
  return {
    id: partial.id,
    name: partial.name,
    auth: {
      ...(partial.supportsApiKeyLogin
        ? {
            apiKey: {
              name: `${partial.name} API key`,
              async login() {
                return { type: "api_key" as const, key: "stored" };
              },
              async resolve() {
                return undefined;
              },
            },
          }
        : {}),
      ...(partial.supportsOauth
        ? {
            oauth: {
              name: `${partial.name} OAuth`,
              async login() {
                return {
                  type: "oauth" as const,
                  refresh: "r",
                  access: "a",
                  expires: Date.now() + 60_000,
                };
              },
              async refresh(c) {
                return c;
              },
              async toAuth() {
                return { apiKey: "x" };
              },
            },
          }
        : {}),
    },
    getModels: () => [],
    stream: () => {
      throw new Error("not implemented");
    },
    streamSimple: () => {
      throw new Error("not implemented");
    },
  } as unknown as Provider;
}

function createFakeRuntime(options?: {
  providers?: Provider[];
  onLogin?: (
    providerId: string,
    type: "api_key" | "oauth",
    interaction: AuthInteraction,
  ) => Promise<void>;
}): ProviderAuthRuntime {
  const providers = options?.providers ?? [
    fakeProvider({
      id: "key-provider",
      name: "Key Provider",
      supportsApiKeyLogin: true,
    }),
    fakeProvider({
      id: "oauth-provider",
      name: "OAuth Provider",
      supportsOauth: true,
    }),
  ];
  const store = new Map<string, "api_key" | "oauth">();

  return {
    getProviders: () => providers,
    getProvider: (id) => providers.find((p) => p.id === id),
    getProviderAuthStatus: (id) => ({
      configured: store.has(id),
      source: store.has(id) ? "stored" : undefined,
    }),
    listCredentials: async () =>
      [...store.entries()].map(([providerId, type]) => ({ providerId, type })),
    checkAuth: async (id) => {
      const type = store.get(id);
      return type ? { type, source: "stored" } : undefined;
    },
    login: async (providerId, type, interaction) => {
      if (options?.onLogin) {
        await options.onLogin(providerId, type, interaction);
      } else {
        const secret = await interaction.prompt({
          type: "secret",
          message: "API key",
        });
        if (!secret) throw new Error("missing secret");
      }
      store.set(providerId, type);
      return { type, key: "redacted" };
    },
    logout: async (providerId) => {
      store.delete(providerId);
    },
  };
}

function makeTestContext(runtime: ProviderAuthRuntime): ProviderAuthContext {
  return {
    createRuntime: async () => runtime,
    lock: makeMutationLock(),
  };
}

describe("providerAuth", () => {

  it("lists providers with capability flags and no secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pa-list-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime();
    const ctx = makeTestContext(runtime);

    const listed = await listProviders(root, ctx);
    expect(listed.authShell).toBe("pi");
    expect(listed.via).toBe("pi");
    expect(listed.providers).toEqual([
      {
        id: "key-provider",
        name: "Key Provider",
        supportsApiKey: true,
        supportsOauth: false,
      },
      {
        id: "oauth-provider",
        name: "OAuth Provider",
        supportsApiKey: false,
        supportsOauth: true,
        oauthLabel: "OAuth Provider OAuth",
      },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(
      /accessToken|refreshToken|"key"\s*:|sk-[a-zA-Z0-9]/,
    );
  });

  it("loginWithApiKey configures then logout clears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pa-login-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const marker = "sk-test-secret-marker-UNIT-XYZ";
    let seenSecret: string | undefined;
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        seenSecret = await interaction.prompt({
          type: "secret",
          message: "key",
        });
      },
    });
    const ctx = makeTestContext(runtime);

    const afterLogin = await loginWithApiKey(root, "key-provider", marker, ctx);
    expect(seenSecret).toBe(marker);
    expect(afterLogin).toEqual({
      providerId: "key-provider",
      configured: true,
      authKind: "api_key",
      source: "stored",
    });
    expect(JSON.stringify(afterLogin)).not.toContain(marker);

    const status = await getAuthStatus(root, "key-provider", ctx);
    expect(status).toMatchObject({ configured: true, authKind: "api_key" });

    const afterLogout = await logoutProvider(root, "key-provider", ctx);
    expect(afterLogout.configured).toBe(false);
    expect(JSON.stringify(afterLogout)).not.toContain(marker);
  });

  it("rejects oauth-style unexpected prompts and unknown providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pa-err-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        await interaction.prompt({ type: "text", message: "unexpected" });
      },
    });
    const ctx = makeTestContext(runtime);

    await expect(
      loginWithApiKey(root, "key-provider", "sk-x", ctx),
    ).rejects.toBeInstanceOf(ProviderAuthError);

    await expect(
      loginWithApiKey(root, "missing", "sk-x", ctx),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      loginWithApiKey(root, "oauth-provider", "sk-x", ctx),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not persist api keys into settings.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pa-settings-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime();
    const ctx = makeTestContext(runtime);
    const marker = "sk-test-secret-marker-SETTINGS";
    await loginWithApiKey(root, "key-provider", marker, ctx);
    const settings = await readFile(
      path.join(storeRootFor(root), "settings.json"),
      "utf8",
    );
    expect(settings).not.toContain(marker);
    expect(settings).toContain("sf_owned");
    expect(sfOwnedAuthPath(root).endsWith("auth.json")).toBe(true);
  });
});
