import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import {
  makeMutationLock,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { runProvidersCommand } from "../src/cli/providersCommand.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import { readCredentialSourceFromFile } from "../src/runtime/settingsFile.js";
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
  onLogout?: (providerId: string) => Promise<void>;
  logoutError?: Error;
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
    fakeProvider({
      id: "dual-provider",
      name: "Dual Provider",
      supportsApiKeyLogin: true,
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
      if (options?.logoutError) throw options.logoutError;
      if (options?.onLogout) await options.onLogout(providerId);
      store.delete(providerId);
    },
  };
}

function captureIo(env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    combined: () => [...stdout, ...stderr].join("\n"),
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
      env,
      readSecret: async () => {
        throw new Error("readSecret not stubbed");
      },
      createAuthInteraction: () => {
        throw new Error("createAuthInteraction not stubbed");
      },
    },
  };
}

function makeTestContext(runtime: ProviderAuthRuntime): ProviderAuthContext {
  return { createRuntime: async () => runtime, lock: makeMutationLock() };
}

describe("CLI providers", () => {

  it("list prints provider ids and capability flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-list-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(createFakeRuntime());
    const cap = captureIo();
    const code = await runProvidersCommand(["list"], root, cap.io, ctx);
    expect(code).toBe(0);
    expect(cap.combined()).toMatch(/key-provider/);
    expect(cap.combined()).toMatch(/oauth-provider/);
    expect(cap.combined()).toMatch(/api_key/);
    expect(cap.combined()).toMatch(/oauth/);
    expect(cap.combined()).not.toMatch(/accessToken|"key"\s*:/);
  });

  it("status lists all or filters by --provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-status-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(createFakeRuntime());

    const all = captureIo();
    expect(await runProvidersCommand(["status"], root, all.io, ctx)).toBe(0);
    expect(all.combined()).toMatch(/key-provider/);
    expect(all.combined()).toMatch(/oauth-provider/);
    expect(all.combined()).toMatch(/dual-provider/);

    const one = captureIo();
    expect(
      await runProvidersCommand(
        ["status", "--provider", "key-provider"],
        root,
        one.io,
        ctx,
      ),
    ).toBe(0);
    expect(one.combined()).toMatch(/key-provider/);
    expect(one.combined()).not.toMatch(/oauth-provider/);

    const missing = captureIo();
    expect(
      await runProvidersCommand(
        ["status", "--provider", "no-such"],
        root,
        missing.io,
        ctx,
      ),
    ).toBe(1);
    expect(missing.combined()).toMatch(/Provider not found/);
    expect(missing.combined()).not.toMatch(/sk-|token/i);
  });

  it("detect prints safe booleans without auth file contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-detect-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const secretPath = path.join(storeRootFor(root), "auth.json");
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(
      secretPath,
      JSON.stringify({ "key-provider": { type: "api_key", key: "SECRET-DETECT-MARKER" } }),
      "utf8",
    );
    const cap = captureIo();
    const code = await runProvidersCommand(["detect"], root, cap.io);
    expect(code).toBe(0);
    expect(cap.combined()).toMatch(/piHomeUsable=/);
    expect(cap.combined()).toMatch(/provisional=/);
    expect(cap.combined()).toMatch(/credentialSource=sf_owned|bindingSource=/);
    expect(cap.combined()).not.toContain("SECRET-DETECT-MARKER");
  });

  it("source get prints credential source or unset messaging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-source-get-"));
    const unset = captureIo();
    expect(await runProvidersCommand(["source", "get"], root, unset.io)).toBe(
      0,
    );
    expect(unset.combined()).toMatch(/unset|pi_home|sf_owned/);

    writeCredentialSourceToFile(root, "pi_home");
    const set = captureIo();
    expect(await runProvidersCommand(["source"], root, set.io)).toBe(0);
    expect(set.stdout.join("\n").trim()).toBe("pi_home");
  });

  it("source set round-trips and rejects invalid values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-source-set-"));
    writeCredentialSourceToFile(root, "pi_home");

    const ok = captureIo();
    expect(
      await runProvidersCommand(["source", "set", "sf_owned"], root, ok.io),
    ).toBe(0);
    expect(ok.stdout.join("\n").trim()).toBe("sf_owned");
    expect(readCredentialSourceFromFile(root)).toBe("sf_owned");

    const bad = captureIo();
    expect(
      await runProvidersCommand(["source", "set", "bogus"], root, bad.io),
    ).toBe(1);
    expect(readCredentialSourceFromFile(root)).toBe("sf_owned");
    expect(bad.combined()).toMatch(/pi_home or sf_owned/);
  });

  it("logout disconnects and maps failures without secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-logout-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let loggedOut: string | undefined;
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        await interaction.prompt({ type: "secret", message: "key" });
      },
      onLogout: async (id) => {
        loggedOut = id;
      },
    });
    const ctx = makeTestContext(runtime);

    const login = captureIo({ SF_TEST_KEY: "sk-logout-setup" });
    login.io.readSecret = async () => "sk-logout-setup";
    await runProvidersCommand(
      ["login", "key-provider", "--api-key-env", "SF_TEST_KEY"],
      root,
      login.io,
      ctx,
    );

    const out = captureIo();
    expect(
      await runProvidersCommand(["logout", "key-provider"], root, out.io, ctx),
    ).toBe(0);
    expect(loggedOut).toBe("key-provider");
    expect(out.combined()).toMatch(/disconnected|configured/);
    expect(out.combined()).not.toContain("sk-logout-setup");

    const ctxFail = makeTestContext(
      createFakeRuntime({
        logoutError: new Error("boom with sk-LEAK-MARKER-xyz"),
      }),
    );
    const fail = captureIo();
    expect(
      await runProvidersCommand(["logout", "key-provider"], root, fail.io, ctxFail),
    ).toBe(1);
    expect(fail.combined()).toMatch(/logout failed|Provider/i);
    expect(fail.combined()).not.toContain("sk-LEAK-MARKER-xyz");
  });

  it("api-key login via --api-key-env never echoes the marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-apikey-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const marker = "sk-test-secret-marker-CLI-ENV-XYZ";
    let seen: string | undefined;
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          seen = await interaction.prompt({
            type: "secret",
            message: "key",
          });
        },
      }),
    );
    const cap = captureIo({ SF_TEST_KEY: marker });
    const code = await runProvidersCommand(
      ["login", "key-provider", "--type", "api_key", "--api-key-env", "SF_TEST_KEY"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(0);
    expect(seen).toBe(marker);
    expect(cap.combined()).not.toContain(marker);
    expect(cap.combined()).toMatch(/key-provider/);
  });

  it("missing --api-key-env var exits non-zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-apikey-missing-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(createFakeRuntime());
    const cap = captureIo({});
    const code = await runProvidersCommand(
      ["login", "key-provider", "--api-key-env", "SF_MISSING_KEY"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(1);
    expect(cap.combined()).toMatch(/not set/);
  });

  it("rejects raw --api-key and does not treat positional as secret", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-apikey-raw-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let loginCalled = false;
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async () => {
          loginCalled = true;
        },
      }),
    );
    const marker = "sk-positional-MARKER-should-not-login";
    const cap = captureIo();
    const code = await runProvidersCommand(
      ["login", "key-provider", "--api-key", marker],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(1);
    expect(loginCalled).toBe(false);
    expect(cap.combined()).toMatch(/--api-key-env|not supported/);
    expect(cap.combined()).not.toContain(marker);
  });

  it("scrubs marker from login error messages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-apikey-scrub-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const marker = "sk-error-MARKER-ABC123";
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async () => {
          throw new Error(`upstream rejected ${marker}`);
        },
      }),
    );
    const cap = captureIo({ SF_TEST_KEY: marker });
    const code = await runProvidersCommand(
      ["login", "key-provider", "--api-key-env", "SF_TEST_KEY"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(1);
    expect(cap.combined()).not.toContain(marker);
    expect(cap.combined()).toMatch(/redacted|failed|login/i);
  });

  it("dual-capable provider without --type exits non-zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-dual-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(createFakeRuntime());
    const cap = captureIo();
    const code = await runProvidersCommand(
      ["login", "dual-provider", "--api-key-env", "SF_TEST_KEY"],
      root,
      { ...cap.io, env: { SF_TEST_KEY: "x" } },
      ctx,
    );
    expect(code).toBe(1);
    expect(cap.combined()).toMatch(/--type/);
  });
});
