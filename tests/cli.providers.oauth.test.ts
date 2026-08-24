import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import {
  loginWithOauth,
  makeMutationLock,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { runProvidersCommand } from "../src/cli/providersCommand.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";
import * as oauthSessionApis from "../src/agent/oauthSessionManager.js";

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
  onLogin?: (
    providerId: string,
    type: "api_key" | "oauth",
    interaction: AuthInteraction,
  ) => Promise<void>;
}): ProviderAuthRuntime {
  const providers = [
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
      try {
        if (options?.onLogin) {
          await options.onLogin(providerId, type, interaction);
        }
        store.set(providerId, type);
        return { type, key: "redacted" };
      } catch (err) {
        if (err instanceof CredentialSynchronizationError) {
          store.set(providerId, type);
        }
        throw err;
      }
    },
    logout: async (providerId) => {
      store.delete(providerId);
    },
  };
}

function captureIo() {
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
      env: {},
      readSecret: async () => {
        throw new Error("unexpected secret prompt");
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

describe("CLI providers oauth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loginWithOauth completes auth_url + manual_code without echoing secret answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-lib-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const canary = "PASTE-URL-CANARY-secret-xyz";
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://example.test/oauth",
            instructions: "Open and sign in",
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Paste redirect URL",
          });
          if (code !== canary) throw new Error("wrong answer");
        },
      }),
    );

    const result = await loginWithOauth(root, "oauth-provider", {
      async prompt() {
        return canary;
      },
      notify() {},
    }, ctx);
    expect(result.provider.configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("oauth login via CLI drives notify/prompt and hides secret answers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-cli-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const canary = "OAUTH-ANSWER-MARKER-secret";
    const notified: string[] = [];
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://example.test/oauth",
            instructions: "Open and sign in",
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Paste redirect URL",
          });
          if (code !== canary) throw new Error("wrong answer");
        },
      }),
    );

    const cap = captureIo();
    const startSpy = vi.spyOn(oauthSessionApis, "startOAuthLoginSession");
    const answerSpy = vi.spyOn(oauthSessionApis, "answerLoginSession");
    const cancelSpy = vi.spyOn(oauthSessionApis, "cancelLoginSession");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    cap.io.createAuthInteraction = () => ({
      notify(event) {
        if (event.type === "auth_url") {
          notified.push(event.url);
          cap.io.error(event.instructions ?? "");
          cap.io.error(`Open: ${event.url}`);
        }
      },
      async prompt(prompt) {
        if (prompt.type === "manual_code") return canary;
        throw new Error(`unexpected prompt ${prompt.type}`);
      },
    });

    const code = await runProvidersCommand(
      ["login", "oauth-provider", "--type", "oauth"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(0);
    expect(notified).toEqual(["https://example.test/oauth"]);
    expect(cap.combined()).toMatch(/example\.test\/oauth/);
    expect(cap.combined()).not.toContain(canary);
    expect(startSpy).not.toHaveBeenCalled();
    expect(answerSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("device_code notify shows user code without access tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-device-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const deviceCode = "DEVICE-USER-CODE-ABCD";
    const accessToken = "ACCESS-TOKEN-SHOULD-NOT-PRINT";
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          interaction.notify({
            type: "device_code",
            userCode: deviceCode,
            verificationUri: "https://example.test/device",
          });
        },
      }),
    );
    const cap = captureIo();
    cap.io.createAuthInteraction = () => ({
      notify(event) {
        if (event.type === "device_code") {
          cap.io.error(`Visit: ${event.verificationUri}`);
          cap.io.error(`Code: ${event.userCode}`);
        }
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    });
    const code = await runProvidersCommand(
      ["login", "oauth-provider"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(0);
    expect(cap.combined()).toContain(deviceCode);
    expect(cap.combined()).toContain("https://example.test/device");
    expect(cap.combined()).not.toContain(accessToken);
  });

  it("select and text prompts receive answers from interaction adapter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-select-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const seen: string[] = [];
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          seen.push(
            await interaction.prompt({
              type: "select",
              message: "Pick account",
              options: [
                { id: "a", label: "Account A" },
                { id: "b", label: "Account B" },
              ],
            }),
          );
          seen.push(
            await interaction.prompt({
              type: "text",
              message: "Nickname",
            }),
          );
        },
      }),
    );
    const cap = captureIo();
    cap.io.createAuthInteraction = () => ({
      notify() {},
      async prompt(prompt) {
        if (prompt.type === "select") return "b";
        if (prompt.type === "text") return "nick";
        throw new Error(`unexpected ${prompt.type}`);
      },
    });
    expect(
      await runProvidersCommand(["login", "oauth-provider"], root, cap.io, ctx),
    ).toBe(0);
    expect(seen).toEqual(["b", "nick"]);
  });

  it("abort/cancel path exits non-zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-abort-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async (_id, _type, interaction) => {
          await interaction.prompt({
            type: "text",
            message: "waiting",
          });
        },
      }),
    );
    const cap = captureIo();
    cap.io.createAuthInteraction = (signal) => ({
      signal,
      notify() {},
      async prompt() {
        throw new Error("Login cancelled");
      },
    });
    const code = await runProvidersCommand(
      ["login", "oauth-provider"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(1);
    expect(cap.combined()).toMatch(/cancel/i);
  });

  it("dual-capable without --type fails before oauth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-dual-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let called = false;
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async () => {
          called = true;
        },
      }),
    );
    const cap = captureIo();
    const code = await runProvidersCommand(
      ["login", "dual-provider"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(cap.combined()).toMatch(/--type/);
  });

  it("CredentialSynchronizationError is soft success with safe warning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-oauth-sync-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const leak = "SYNC-SECRET-TOKEN-xyz";
    const ctx = makeTestContext(
      createFakeRuntime({
        onLogin: async () => {
          throw new CredentialSynchronizationError(
            "oauth-provider",
            "login",
            {
              type: "oauth",
              refresh: "r",
              access: leak,
              expires: Date.now() + 60_000,
            },
            { cause: new Error("sync failed") },
          );
        },
      }),
    );
    const cap = captureIo();
    cap.io.createAuthInteraction = () => ({
      notify() {},
      async prompt() {
        return "x";
      },
    });
    const code = await runProvidersCommand(
      ["login", "oauth-provider"],
      root,
      cap.io,
      ctx,
    );
    expect(code).toBe(0);
    expect(cap.combined()).toMatch(/sync failed|Connected/i);
    expect(cap.combined()).not.toContain(leak);
    expect(cap.combined()).toMatch(/oauth-provider/);
  });
});
