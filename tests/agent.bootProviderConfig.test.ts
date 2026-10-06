import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { bootProviderConfig } from "../src/agent/bootProviderConfig.js";
import {
  makeMutationLock,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { SecretFromEnvError } from "../src/config/secretFromEnvOrFile.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function fakeProvider(id: string): Provider {
  return {
    id,
    name: id,
    auth: {
      apiKey: {
        name: `${id} API key`,
        async login() {
          return { type: "api_key" as const, key: "stored" };
        },
        async resolve() {
          return undefined;
        },
      },
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
  rejectIds?: Set<string>;
}): ProviderAuthRuntime {
  const providers = [fakeProvider("key-provider")];
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
      if (options?.rejectIds?.has(providerId)) {
        throw new Error("rejected key");
      }
      const secret = await interaction.prompt({
        type: "secret",
        message: "API key",
      });
      if (!secret) throw new Error("missing secret");
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

describe("bootProviderConfig", () => {
  it("configures provider from env API key", async () => {
    const runtime = createFakeRuntime();
    const result = await bootProviderConfig({
      cwd: mkdtempSync(path.join(tmpdir(), "sf-boot-prov-")),
      env: { STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY: "secret-value" },
      authContext: makeTestContext(runtime),
    });
    expect(result.configured).toEqual(["key-provider"]);
    expect(result.failures).toEqual([]);
    expect(await runtime.checkAuth("key-provider")).toEqual({
      type: "api_key",
      source: "stored",
    });
  });

  it("configures from _FILE with trailing newline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-boot-file-"));
    temps.push(dir);
    const file = path.join(dir, "key");
    writeFileSync(file, "file-secret\n", "utf8");
    const runtime = createFakeRuntime();
    const result = await bootProviderConfig({
      cwd: dir,
      env: { STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY_FILE: file },
      authContext: makeTestContext(runtime),
    });
    expect(result.configured).toEqual(["key-provider"]);
  });

  it("both plain and _FILE is a boot error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-boot-both-"));
    temps.push(dir);
    const file = path.join(dir, "key");
    writeFileSync(file, "file-secret\n", "utf8");
    await expect(
      bootProviderConfig({
        cwd: dir,
        env: {
          STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY: "plain",
          STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY_FILE: file,
        },
        authContext: makeTestContext(createFakeRuntime()),
      }),
    ).rejects.toBeInstanceOf(SecretFromEnvError);
  });

  it("unreadable file soft-fails and host path continues", async () => {
    const errors: string[] = [];
    const result = await bootProviderConfig({
      cwd: mkdtempSync(path.join(tmpdir(), "sf-boot-miss-")),
      env: {
        STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY_FILE: "/no/such/file",
      },
      authContext: makeTestContext(createFakeRuntime()),
      logError: (m) => errors.push(m),
    });
    expect(result.configured).toEqual([]);
    expect(result.failures[0]?.providerId).toBe("key-provider");
    expect(errors.join("\n")).not.toMatch(/file-secret|super-secret/i);
  });

  it("requireProviders missing id is fatal", async () => {
    await expect(
      bootProviderConfig({
        cwd: mkdtempSync(path.join(tmpdir(), "sf-boot-req-")),
        env: {},
        requireProviders: ["key-provider"],
        authContext: makeTestContext(createFakeRuntime()),
      }),
    ).rejects.toThrow(/STAGEFLOW_REQUIRE_PROVIDERS/);
  });

  it("rejected key soft-fails without leaking secret", async () => {
    const errors: string[] = [];
    const secret = "super-secret-value-do-not-leak";
    const result = await bootProviderConfig({
      cwd: mkdtempSync(path.join(tmpdir(), "sf-boot-rej-")),
      env: { STAGEFLOW_PROVIDER_KEY_PROVIDER_API_KEY: secret },
      authContext: makeTestContext(
        createFakeRuntime({ rejectIds: new Set(["key-provider"]) }),
      ),
      logError: (m) => errors.push(m),
    });
    expect(result.failures[0]?.code).toBe("provider_not_configured");
    expect(errors.join("\n")).not.toContain(secret);
  });
});
