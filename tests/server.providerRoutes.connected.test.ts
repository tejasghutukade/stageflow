import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { makeMutationLock } from "../src/agent/providerAuth.js";
import { handleProviderRoutes } from "../src/server/providerRoutes.js";

function fakeRuntime(failLogin: boolean) {
  const stored = new Set<string>();
  const provider = { id: "acme", name: "Acme", auth: { apiKey: { login: async () => ({}) } } };
  return {
    getProviders: () => [provider],
    getProvider: (id: string) => (id === "acme" ? provider : undefined),
    getProviderAuthStatus: (id: string) => ({ configured: stored.has(id) }),
    listCredentials: async () => [...stored].map((providerId) => ({ providerId, type: "api_key" as const })),
    checkAuth: async () => undefined,
    login: async (id: string) => {
      if (failLogin) throw new Error("invalid key");
      stored.add(id);
    },
    logout: async () => undefined,
  };
}

async function postLogin(failLogin: boolean): Promise<{ status: number; connected: number }> {
  let status = 0;
  let connected = 0;
  await handleProviderRoutes({ method: "POST", url: "/api/providers/acme/login" } as IncomingMessage, {} as ServerResponse, {
    cwd: process.cwd(),
    readJsonBody: async () => ({ authType: "api_key", apiKey: "sk-test" }),
    json: (_res, code) => {
      status = code;
    },
    providerAuthContext: { createRuntime: async () => fakeRuntime(failLogin) as never, lock: makeMutationLock() },
    onProviderConnected: () => {
      connected += 1;
    },
  });
  return { status, connected };
}

describe("provider routes: onProviderConnected", () => {
  it("fires after an API key login succeeds", async () => {
    expect(await postLogin(false)).toEqual({ status: 200, connected: 1 });
  });

  it("does not fire when the login fails", async () => {
    const result = await postLogin(true);
    expect(result.status).not.toBe(200);
    expect(result.connected).toBe(0);
  });
});
