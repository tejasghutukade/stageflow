import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { PI_CODING_AGENT_DIR_ENV } from "../src/runtime/stageRoots.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import {
  detectPiHome,
  getAuthStatus,
  listProviders,
  loginWithApiKey,
  configurePiProviderApiKey,
  logoutProvider,
  makeMutationLock,
  ProviderAuthError,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import {
  inspectProviderReadiness,
  mapProviderAuthError,
} from "../src/agent/providerInspect.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import { sfOwnedAuthPath } from "../src/runtime/credentialBinding.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

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
  credentials?: Record<string, "api_key" | "oauth">;
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
  const store = new Map<string, "api_key" | "oauth">(
    Object.entries(options?.credentials ?? {}),
  );

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

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withDistinctRoots<T>(
  fn: (roots: { data: string; creds: string }) => Promise<T>,
): Promise<T> {
  const data = await mkdtemp(path.join(tmpdir(), "sf-pa-data-"));
  const creds = await mkdtemp(path.join(tmpdir(), "sf-pa-cred-"));
  const prev = {
    STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
    credentialHome: process.env[CREDENTIAL_HOME_ENV],
    piAgentDir: process.env[PI_CODING_AGENT_DIR_ENV],
  };
  process.env.STAGEFLOW_HOME = data;
  process.env[CREDENTIAL_HOME_ENV] = creds;
  resetGlobalStageflowHomeForTests();
  try {
    return await fn({ data, creds });
  } finally {
    restoreEnv("STAGEFLOW_HOME", prev.STAGEFLOW_HOME);
    restoreEnv(CREDENTIAL_HOME_ENV, prev.credentialHome);
    restoreEnv(PI_CODING_AGENT_DIR_ENV, prev.piAgentDir);
    resetGlobalStageflowHomeForTests();
    await rm(data, { recursive: true, force: true });
    await rm(creds, { recursive: true, force: true });
  }
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
    await withIsolatedHome(async (home) => {
      writeCredentialSourceToFile(home, "sf_owned");
      const runtime = createFakeRuntime();
      const ctx = makeTestContext(runtime);
      const marker = "sk-test-secret-marker-SETTINGS";
      await loginWithApiKey(home, "key-provider", marker, ctx);
      const settings = await readFile(
        path.join(storeRootFor(home), "settings.json"),
        "utf8",
      );
      expect(settings).not.toContain(marker);
      expect(settings).toContain("sf_owned");
      expect(sfOwnedAuthPath().endsWith("auth.json")).toBe(true);
    });
  });

  it("opens models.json beside the operator auth file for login and logout, and for list only when auth.json exists", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      const runtime = createFakeRuntime();
      const create = vi
        .spyOn(ModelRuntime, "create")
        .mockImplementation(
          async () =>
            runtime as Awaited<ReturnType<typeof ModelRuntime.create>>,
        );
      process.env[PI_CODING_AGENT_DIR_ENV] = path.join(data, "agent");
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const expected = {
        authPath: operatorAuth,
        modelsPath: path.join(creds, "agent", "models.json"),
        refreshOnCreate: false,
      };
      try {
        await listProviders(data);
        expect(create).not.toHaveBeenCalled();
        expect(existsSync(operatorAuth)).toBe(false);

        await loginWithApiKey(data, "key-provider", "sk-test-secret-marker-MODELS");
        await logoutProvider(data, "key-provider");
        expect(create.mock.calls.map((call) => call[0])).toEqual([
          expected,
          expected,
        ]);

        create.mockClear();
        await mkdir(path.dirname(operatorAuth), { recursive: true });
        await writeFile(operatorAuth, "{}\n");
        await listProviders(data);
        expect(create.mock.calls.map((call) => call[0])).toEqual([expected]);
        expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(
          path.join(data, "agent"),
        );
      } finally {
        create.mockRestore();
      }
    });
  });

  it("detects and lists the operator auth file without creating it when the data directory differs", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const dataAuth = path.join(data, "agent", "auth.json");
      const dataCursor = path.join(data, "agent", "cursor-api-key");
      const operatorCursor = path.join(creds, "agent", "cursor-api-key");
      await mkdir(path.dirname(dataAuth), { recursive: true });
      const dataBody = `${JSON.stringify({
        openai: { type: "api_key", key: "data-only-secret" },
      })}\n`;
      await writeFile(dataAuth, dataBody);
      await writeFile(dataCursor, "cursor-data-only\n");
      const prevCursor = process.env.CURSOR_API_KEY;
      const prevCursorFile = process.env.CURSOR_API_KEY_FILE;
      delete process.env.CURSOR_API_KEY;
      delete process.env.CURSOR_API_KEY_FILE;
      try {
        const missing = detectPiHome(data);
        expect(missing.authConfigured).toBe(false);
        expect(missing.cursorApiKeyConfigured).toBe(false);
        expect(missing.source).toBe("sf_owned");
        expect(missing).not.toHaveProperty("authPath");
        expect(JSON.stringify(missing)).not.toMatch(
          /data-only-secret|cursor-data-only/,
        );

        const listed = await listProviders(data);
        expect(listed.providers.some((provider) => provider.id === "deepseek")).toBe(
          true,
        );
        expect(JSON.stringify(listed)).not.toContain("data-only-secret");
        await expect(getAuthStatus(data, "deepseek")).resolves.toMatchObject({
          providerId: "deepseek",
          configured: false,
        });
        await expect(
          getAuthStatus(data, "not-a-real-provider-zz"),
        ).rejects.toMatchObject({ status: 404 });
        expect(existsSync(operatorAuth)).toBe(false);
        expect(await readFile(dataAuth, "utf8")).toBe(dataBody);

        await mkdir(path.dirname(operatorCursor), { recursive: true });
        await writeFile(operatorCursor, "cursor-operator-key\n");
        const withCursor = detectPiHome(data);
        expect(withCursor.cursorApiKeyConfigured).toBe(true);
        expect(withCursor.authConfigured).toBe(false);
        expect(JSON.stringify(withCursor)).not.toContain("cursor-operator-key");

        const operatorBody = `${JSON.stringify({
          openai: { type: "api_key", key: "operator-secret" },
        })}\n`;
        await writeFile(operatorAuth, operatorBody);
        const configured = detectPiHome(data);
        expect(configured.authConfigured).toBe(true);
        expect(JSON.stringify(configured)).not.toMatch(
          /operator-secret|data-only-secret|cursor-operator-key/,
        );
        expect(await readFile(dataAuth, "utf8")).toBe(dataBody);
      } finally {
        if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
        else process.env.CURSOR_API_KEY = prevCursor;
        if (prevCursorFile === undefined) delete process.env.CURSOR_API_KEY_FILE;
        else process.env.CURSOR_API_KEY_FILE = prevCursorFile;
      }
    });
  });

  it("login and logout write the operator auth file when the data directory differs", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      const marker = "sk-test-secret-marker-U5-operator";
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const dataAuth = path.join(data, "agent", "auth.json");
      await mkdir(path.dirname(dataAuth), { recursive: true });
      await writeFile(dataAuth, "{}\n");

      const afterLogin = await loginWithApiKey(data, "deepseek", marker);
      expect(afterLogin).toMatchObject({
        providerId: "deepseek",
        configured: true,
        authKind: "api_key",
      });
      expect(JSON.stringify(afterLogin)).not.toContain(marker);
      expect(await readFile(operatorAuth, "utf8")).toContain(marker);
      expect(await readFile(dataAuth, "utf8")).toBe("{}\n");

      const afterLogout = await logoutProvider(data, "deepseek");
      expect(afterLogout.configured).toBe(false);
      expect(JSON.stringify(afterLogout)).not.toContain(marker);
      expect(await readFile(operatorAuth, "utf8")).not.toContain(marker);
      expect(await readFile(dataAuth, "utf8")).toBe("{}\n");
    });
  });

  it("keeps PI_CODING_AGENT_DIR on the process agent directory when the credential root differs", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      expect(sfOwnedAuthPath()).toBe(path.join(creds, "agent", "auth.json"));
      const { root, cleanup } = await initTempGitRepo();
      delete process.env[PI_CODING_AGENT_DIR_ENV];
      try {
        const boot = await bootstrapStageflowHost({
          agent: scriptedFakeAgent([]),
          cwd: root,
          skipHostConfig: true,
        });
        await boot.mcpHandler.close();
        boot.stopGcInterval();
        boot.stopScheduleSource();
        boot.stopGithubPollSource();
        boot.stopEmailSource();
        expect(process.env[PI_CODING_AGENT_DIR_ENV]).toBe(
          path.join(data, "agent"),
        );
        expect(boot.agentDir).toBe(path.join(data, "agent"));
      } finally {
        await cleanup();
      }
    });
  });
});

describe("inspectProviderReadiness", () => {
  afterEach(() => {
    clearFindProjectRootCacheForTests();
  });

  it("returns configured login-capable rows plus detect and no secrets", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      writeCredentialSourceToFile(root, "sf_owned");
      clearFindProjectRootCacheForTests();
      const runtime = createFakeRuntime({
        credentials: { "key-provider": "api_key" },
        providers: [
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
          fakeProvider({
            id: "env-only",
            name: "Env Only",
          }),
        ],
      });
      const inspect = await inspectProviderReadiness(
        root,
        makeTestContext(runtime),
      );
      expect(inspect.authShell).toBe("pi");
      expect(inspect.via).toBe("pi");
      expect(inspect.providers.map((p) => p.id)).toEqual([
        "key-provider",
        "oauth-provider",
      ]);
      expect(inspect.providers[0]).toEqual({
        id: "key-provider",
        name: "Key Provider",
        supportsApiKey: true,
        supportsOauth: false,
        configured: true,
        authKind: "api_key",
        source: "stored",
      });
      expect(inspect.providers[1]).toMatchObject({
        id: "oauth-provider",
        name: "OAuth Provider",
        supportsApiKey: false,
        supportsOauth: true,
        configured: false,
      });
      expect(typeof inspect.detect.authConfigured).toBe("boolean");
      expect(inspect.detect.source).toBe("sf_owned");
      expect(inspect.detect).not.toHaveProperty("authPath");
      expect(inspect).not.toHaveProperty("authPath");
      expect(JSON.stringify(inspect)).not.toMatch(
        /accessToken|refreshToken|"apiKey"|"key"\s*:|authPath|sk-/,
      );
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("treats unconfigured as success with configured false", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      writeCredentialSourceToFile(root, "sf_owned");
      clearFindProjectRootCacheForTests();
      const inspect = await inspectProviderReadiness(
        root,
        makeTestContext(createFakeRuntime()),
      );
      expect(inspect.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "key-provider",
            configured: false,
          }),
        ]),
      );
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

describe("mapProviderAuthError", () => {
  it("passes ProviderAuthError status through", () => {
    expect(
      mapProviderAuthError(new ProviderAuthError("Provider not found", 404)),
    ).toEqual({
      status: 404,
      body: { error: "Provider not found" },
    });
    expect(mapProviderAuthError(new ProviderAuthError("nope", 502))).toEqual({
      status: 502,
      body: { error: "nope" },
    });
  });

  it("configurePiProviderApiKey logs in against the supplied auth file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-pi-auth-"));
    const authPath = path.join(dir, "nested", "hosted-agent-auth.json");
    const marker = "sk-test-secret-marker-UNIT-XYZ";
    let seenPath: string | undefined;
    let seenSecret: string | undefined;
    const ctx: ProviderAuthContext = {
      lock: makeMutationLock(),
      createRuntime: async (requested) => {
        seenPath = requested;
        const runtime: ProviderAuthRuntime = {
          getProviders: () => [],
          getProvider: () =>
            ({
              id: "openrouter",
              name: "OpenRouter",
              auth: {
                apiKey: {
                  name: "OpenRouter API key",
                  async login() {
                    return { type: "api_key" as const, key: "stored" };
                  },
                  async resolve() {
                    return undefined;
                  },
                },
              },
            }) as Provider,
          getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
          listCredentials: async () => [{ providerId: "openrouter", type: "api_key" }],
          checkAuth: async () => ({ type: "api_key", source: "stored" }),
          login: async (_id, _type, interaction: AuthInteraction) => {
            seenSecret = await interaction.prompt({ type: "secret", message: "key" });
          },
          logout: async () => undefined,
        };
        return runtime;
      },
    };

    await configurePiProviderApiKey(
      { authPath, providerId: "openrouter", apiKey: marker },
      ctx,
    );

    expect(seenPath).toBe(path.resolve(authPath));
    expect(seenSecret).toBe(marker);
    const stored = await readFile(authPath, "utf8");
    expect(stored).not.toContain(marker);
  });

  it("maps unknown errors to 500 with a generic message", () => {
    expect(mapProviderAuthError(new Error("boom"))).toEqual({
      status: 500,
      body: { error: "Provider auth operation failed" },
    });
    expect(mapProviderAuthError("string-err")).toEqual({
      status: 500,
      body: { error: "Provider auth operation failed" },
    });
  });
});
