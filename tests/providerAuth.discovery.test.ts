import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import {
  isLoginCapable,
  listLoginCapableProviders,
  listProviders,
  makeMutationLock,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";

function fakeProvider(partial: {
  id: string;
  name: string;
  supportsApiKeyLogin?: boolean;
  supportsOauth?: boolean;
  oauthName?: string;
  envOnlyApiKey?: boolean;
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
        : partial.envOnlyApiKey
          ? {
              apiKey: {
                name: `${partial.name} env`,
                async resolve() {
                  return undefined;
                },
              },
            }
          : {}),
      ...(partial.supportsOauth
        ? {
            oauth: {
              name: partial.oauthName ?? `${partial.name} OAuth`,
              async login() {
                return {
                  type: "oauth" as const,
                  refresh: "r",
                  access: "a",
                  expires: Date.now() + 60_000,
                };
              },
              async refresh(c: {
                type: "oauth";
                refresh: string;
                access: string;
                expires: number;
              }) {
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

function createFakeRuntime(providers: Provider[]): ProviderAuthRuntime {
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
    login: async (
      providerId: string,
      type: "api_key" | "oauth",
      _interaction: AuthInteraction,
    ) => {
      store.set(providerId, type);
      return { type, key: "redacted" };
    },
    logout: async (providerId) => {
      store.delete(providerId);
    },
  };
}

function makeTestContext(runtime: ProviderAuthRuntime): ProviderAuthContext {
  return { createRuntime: async () => runtime, lock: makeMutationLock() };
}

describe("providerAuth discovery", () => {

  it("isLoginCapable matches KTD1 (oauth and/or apiKey.login; excludes env-only)", () => {
    const oauth = fakeProvider({
      id: "oauth-only",
      name: "OAuth",
      supportsOauth: true,
    });
    const keyLogin = fakeProvider({
      id: "key-login",
      name: "Key",
      supportsApiKeyLogin: true,
    });
    const both = fakeProvider({
      id: "both",
      name: "Both",
      supportsApiKeyLogin: true,
      supportsOauth: true,
    });
    const envOnly = fakeProvider({
      id: "env-only",
      name: "Env",
      envOnlyApiKey: true,
    });
    expect(isLoginCapable(oauth)).toBe(true);
    expect(isLoginCapable(keyLogin)).toBe(true);
    expect(isLoginCapable(both)).toBe(true);
    expect(isLoginCapable(envOnly)).toBe(false);
  });

  it("listLoginCapableProviders filters and exposes matrix fields", () => {
    const runtime = createFakeRuntime([
      fakeProvider({
        id: "oauth-only",
        name: "OAuth Only",
        supportsOauth: true,
        oauthName: "OAuth Display",
      }),
      fakeProvider({
        id: "key-login",
        name: "Key Login",
        supportsApiKeyLogin: true,
      }),
      fakeProvider({
        id: "env-only",
        name: "Env Only",
        envOnlyApiKey: true,
      }),
    ]);

    const capable = listLoginCapableProviders(runtime);
    expect(capable.map((p) => p.id)).toEqual(["oauth-only", "key-login"]);
    expect(capable).toEqual([
      {
        id: "oauth-only",
        name: "OAuth Only",
        apiKeyLogin: false,
        oauth: true,
        oauthLabel: "OAuth Display",
      },
      {
        id: "key-login",
        name: "Key Login",
        apiKeyLogin: true,
        oauth: false,
      },
    ]);
  });

  it("HTTP listProviders matches login-capable filter and excludes env-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-discovery-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime([
      fakeProvider({
        id: "oauth-only",
        name: "OAuth Only",
        supportsOauth: true,
        oauthName: "Sign in with OAuth",
      }),
      fakeProvider({
        id: "key-login",
        name: "Key Login",
        supportsApiKeyLogin: true,
      }),
      fakeProvider({
        id: "env-only",
        name: "Env Only",
        envOnlyApiKey: true,
      }),
    ]);
    const ctx = makeTestContext(runtime);
    const listed = await listProviders(root, ctx);
    const capable = listLoginCapableProviders(runtime);
    expect(listed.providers.map((p) => p.id)).toEqual(capable.map((p) => p.id));
    expect(listed.providers).toEqual([
      {
        id: "oauth-only",
        name: "OAuth Only",
        supportsApiKey: false,
        supportsOauth: true,
        oauthLabel: "Sign in with OAuth",
      },
      {
        id: "key-login",
        name: "Key Login",
        supportsApiKey: true,
        supportsOauth: false,
      },
    ]);
    expect(listed.providers.some((p) => p.id === "env-only")).toBe(false);
    expect(JSON.stringify(listed)).not.toMatch(
      /accessToken|refreshToken|"key"\s*:|sk-[a-zA-Z0-9]/,
    );
  });
});
