import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  makeMutationLock,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { inspectProviderReadiness } from "../src/agent/providerInspect.js";
import { startUiServer } from "../src/server/http.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";

const SECRET_RE =
  /accessToken|refreshToken|"apiKey"|"key"\s*:|authPath|sk-/;

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
  credentials?: Record<string, "api_key" | "oauth">;
}): ProviderAuthRuntime {
  const providers = [
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
    login: async (providerId, type, interaction: AuthInteraction) => {
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
  return {
    createRuntime: async () => runtime,
    lock: makeMutationLock(),
  };
}

async function mcpListTools(base: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP tools/list: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { tools?: Array<{ name: string }> };
  };
  return message.result?.tools ?? [];
}

async function withProvidersMcp(
  runtime: ProviderAuthRuntime,
  fn: (base: string, cwd: string) => Promise<void>,
): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  writeCredentialSourceToFile(root, "sf_owned");
  clearFindProjectRootCacheForTests();
  const { server } = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: root,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    mcpStateless: true,
    providerAuthContext: makeTestContext(runtime),
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    await fn(`http://127.0.0.1:${address.port}`, root);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    clearFindProjectRootCacheForTests();
    await cleanup();
  }
}

afterEach(() => {
  clearFindProjectRootCacheForTests();
});

describe("MCP list_providers", () => {
  it("T1 payload equals inspectProviderReadiness for a configured row", async () => {
    const runtime = createFakeRuntime({
      credentials: { "key-provider": "api_key" },
    });
    await withProvidersMcp(runtime, async (base, cwd) => {
      const expected = await inspectProviderReadiness(
        cwd,
        makeTestContext(runtime),
      );
      const result = await mcpCall(base, "list_providers");
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual(expected);
      expect(expected.providers.map((p) => p.id)).toEqual([
        "key-provider",
        "oauth-provider",
      ]);
      expect(expected.providers[0]).toMatchObject({
        id: "key-provider",
        configured: true,
        authKind: "api_key",
        source: "stored",
      });
    });
  });

  it("T2 unconfigured provider is success and equals helper", async () => {
    const runtime = createFakeRuntime();
    await withProvidersMcp(runtime, async (base, cwd) => {
      const expected = await inspectProviderReadiness(
        cwd,
        makeTestContext(runtime),
      );
      const result = await mcpCall(base, "list_providers");
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual(expected);
      expect(
        expected.providers.find((p) => p.id === "key-provider"),
      ).toMatchObject({
        id: "key-provider",
        configured: false,
      });
    });
  });

  it("T3 payload includes detect summary and omits authPath", async () => {
    const runtime = createFakeRuntime();
    await withProvidersMcp(runtime, async (base, cwd) => {
      const expected = await inspectProviderReadiness(
        cwd,
        makeTestContext(runtime),
      );
      const result = await mcpCall(base, "list_providers");
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual(expected);
      expect(typeof result.payload.detect.piHomeUsable).toBe("boolean");
      expect(result.payload.detect.source).toMatch(/^(pi_home|sf_owned)$/);
      expect(result.payload.detect.authPath).toBeUndefined();
      expect(result.payload).not.toHaveProperty("authPath");
    });
  });

  it("T4 stringified payload matches no secret patterns", async () => {
    const runtime = createFakeRuntime({
      credentials: { "key-provider": "api_key" },
    });
    await withProvidersMcp(runtime, async (base, cwd) => {
      const expected = await inspectProviderReadiness(
        cwd,
        makeTestContext(runtime),
      );
      const result = await mcpCall(base, "list_providers");
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual(expected);
      expect(JSON.stringify(result.payload)).not.toMatch(SECRET_RE);
    });
  });

  it("T5 tools/list includes list_providers and excludes login tools", async () => {
    const runtime = createFakeRuntime();
    await withProvidersMcp(runtime, async (base) => {
      const names = (await mcpListTools(base)).map((t) => t.name);
      expect(names).toContain("list_providers");
      expect(names.some((n) => /login|logout|oauth/i.test(n))).toBe(false);
    });
  });

  it("does not import HTTP provider routes", async () => {
    const src = await readFile(
      new URL("../src/mcp/providerTools.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/providerRoutes/);
  });
});
