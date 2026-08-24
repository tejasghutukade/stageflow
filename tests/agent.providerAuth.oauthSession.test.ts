import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import {
  makeMutationLock,
  ProviderAuthError,
  type ProviderAuthContext,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import {
  answerLoginSession,
  cancelLoginSession,
  getLoginSession,
  resetSessionsForTests,
  startOAuthLoginSession,
} from "../src/agent/oauthSessionManager.js";
import { writeCredentialSourceToFile } from "../src/runtime/settingsFile.js";

function fakeProvider(partial: {
  id: string;
  name: string;
  supportsOauth?: boolean;
}): Provider {
  return {
    id: partial.id,
    name: partial.name,
    auth: {
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
    fakeProvider({ id: "key-only", name: "Key Only" }),
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

async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeTestContext(runtime: ProviderAuthRuntime): ProviderAuthContext {
  return {
    createRuntime: async () => runtime,
    lock: makeMutationLock(),
  };
}

describe("providerAuth oauth sessions", () => {
  afterEach(() => {
    resetSessionsForTests();
  });

  it("auth_url then manual_code completes without retaining the answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-manual-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const canary = "PASTE-URL-CANARY-secret-xyz";
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        interaction.notify({
          type: "auth_url",
          url: "https://example.test/oauth",
          instructions: "Open and sign in",
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "Paste redirect URL",
          placeholder: "https://...",
        });
        if (code !== canary) throw new Error("wrong answer");
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    expect(started.status).toBe("running");

    await waitFor(() => {
      const s = getLoginSession(started.id);
      return s?.pendingPrompt?.type === "manual_code";
    });
    const pending = getLoginSession(started.id)!;
    expect(pending.events.some((e) => e.type === "auth_url")).toBe(true);

    const afterAnswer = answerLoginSession(started.id, canary);
    expect(JSON.stringify(afterAnswer)).not.toContain(canary);
    expect(afterAnswer.pendingPrompt).toBeUndefined();

    await waitFor(() => getLoginSession(started.id)?.status === "completed");
    const done = getLoginSession(started.id)!;
    expect(done.status).toBe("completed");
    expect(done.provider?.configured).toBe(true);
    expect(JSON.stringify(done)).not.toContain(canary);
  });

  it("device_code notify then completes without prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-device-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const deviceCode = "DEVICE-CODE-CANARY-ABCD";
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: deviceCode,
          verificationUri: "https://example.test/device",
        });
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() =>
      Boolean(
        getLoginSession(started.id)?.events.some((e) => e.type === "device_code"),
      ),
    );
    const mid = getLoginSession(started.id)!;
    expect(
      mid.events.find((e) => e.type === "device_code") &&
        (mid.events.find((e) => e.type === "device_code") as {
          userCode: string;
        }).userCode,
    ).toBe(deviceCode);

    await waitFor(() => getLoginSession(started.id)?.status === "completed");
    expect(getLoginSession(started.id)?.provider?.authKind).toBe("oauth");
  });

  it("select prompt answers with option id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-select-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let chosen: string | undefined;
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        chosen = await interaction.prompt({
          type: "select",
          message: "Pick domain",
          options: [
            { id: "corp", label: "Corporate" },
            { id: "pers", label: "Personal" },
          ],
        });
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => getLoginSession(started.id)?.pendingPrompt?.type === "select");
    answerLoginSession(started.id, "corp");
    await waitFor(() => getLoginSession(started.id)?.status === "completed");
    expect(chosen).toBe("corp");
  });

  it("rejects a second concurrent oauth session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-409-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        await interaction.prompt({ type: "text", message: "hold" });
      },
    });
    const ctx = makeTestContext(runtime);

    const first = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => getLoginSession(first.id)?.pendingPrompt !== undefined);
    await expect(
      startOAuthLoginSession(root, "oauth-provider", ctx),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("cancel rejects pending prompt and marks cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-cancel-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let loginRejected = false;
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        try {
          await interaction.prompt({ type: "secret", message: "token" });
        } catch {
          loginRejected = true;
          throw new Error("aborted");
        }
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => getLoginSession(started.id)?.pendingPrompt !== undefined);
    const cancelled = cancelLoginSession(started.id);
    expect(cancelled.status).toBe("cancelled");
    await waitFor(() => loginRejected);
    expect(getLoginSession(started.id)?.status).toBe("cancelled");
  });

  it("CredentialSynchronizationError becomes completed with warning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-sync-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const runtime = createFakeRuntime({
      onLogin: async () => {
        throw new CredentialSynchronizationError(
          "oauth-provider",
          "login",
          {
            type: "oauth",
            refresh: "r",
            access: "a",
            expires: Date.now() + 60_000,
          },
          { cause: new Error("sync failed") },
        );
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => getLoginSession(started.id)?.status === "completed");
    const done = getLoginSession(started.id)!;
    expect(done.status).toBe("completed");
    expect(done.warning?.message).toMatch(/catalog sync failed/i);
    expect(done.warning?.message).toMatch(/without disconnecting/i);
    expect(done.provider?.configured).toBe(true);
  });

  it("auth_url + aborted manual_code (loopback wins) completes without error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-race-"));
    writeCredentialSourceToFile(root, "sf_owned");
    let promptRejected = false;
    const runtime = createFakeRuntime({
      onLogin: async (_id, _type, interaction) => {
        interaction.notify({
          type: "auth_url",
          url: "https://example.test/oauth",
          instructions: "Open and sign in",
        });
        const promptAbort = new AbortController();
        const pending = interaction.prompt({
          type: "manual_code",
          message: "Paste redirect URL",
          placeholder: "https://...",
          signal: promptAbort.signal,
        });
        await new Promise((r) => setTimeout(r, 15));
        promptAbort.abort();
        await pending.catch(() => {
          promptRejected = true;
        });
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => {
      const s = getLoginSession(started.id);
      return s?.pendingPrompt?.type === "manual_code";
    });
    await waitFor(() => getLoginSession(started.id)?.pendingPrompt === undefined);
    await waitFor(() => getLoginSession(started.id)?.status === "completed");
    const done = getLoginSession(started.id)!;
    expect(promptRejected).toBe(true);
    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.provider?.configured).toBe(true);
    expect(done.events.some((e) => e.type === "auth_url")).toBe(true);
  });

  it("login throw fails with generic message and no secret echo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-fail-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const secret = "SUPER-SECRET-TOKEN-FAIL";
    const runtime = createFakeRuntime({
      onLogin: async () => {
        throw new Error(`provider exploded: ${secret}`);
      },
    });
    const ctx = makeTestContext(runtime);

    const started = await startOAuthLoginSession(root, "oauth-provider", ctx);
    await waitFor(() => getLoginSession(started.id)?.status === "failed");
    const failed = getLoginSession(started.id)!;
    expect(failed.error?.message).toBe("Provider login failed");
    expect(JSON.stringify(failed)).not.toContain(secret);
  });

  it("rejects unknown and non-oauth providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-oauth-bad-"));
    writeCredentialSourceToFile(root, "sf_owned");
    const ctx = makeTestContext(createFakeRuntime());
    await expect(
      startOAuthLoginSession(root, "missing", ctx),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(
      startOAuthLoginSession(root, "key-only", ctx),
    ).rejects.toMatchObject({ status: 400 });
  });
});
