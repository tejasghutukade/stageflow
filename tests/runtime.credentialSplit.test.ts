import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  detectPiHome,
  loginWithApiKey,
  makeMutationLock,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createLiveWorkshopOperatorHost } from "../src/operatorAgent/piModel.js";
import {
  createWorkshopDraftContext,
  emptyDraftPackage,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "../src/operatorAgent/index.js";

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";
const USABLE_AUTH = `${JSON.stringify({
  openai: { type: "api_key", key: "sk-operator" },
})}\n`;
const AUTHOR_MODEL = "anthropic/claude-sonnet-4-5";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function loginRuntime(): ProviderAuthRuntime {
  const store = new Map<string, "api_key" | "oauth">();
  const provider = {
    id: "key-provider",
    name: "Key Provider",
    auth: {
      apiKey: {
        login: async () => ({ type: "api_key" as const, key: "stored" }),
      },
    },
  } as unknown as Provider;
  return {
    getProviders: () => [provider],
    getProvider: (id) => (id === provider.id ? provider : undefined),
    getProviderAuthStatus: (id) => ({
      configured: store.has(id),
      source: store.has(id) ? "stored" : undefined,
    }),
    listCredentials: async () =>
      [...store.entries()].map(([providerId, type]) => ({ providerId, type })),
    checkAuth: async () => undefined,
    login: async (providerId, type) => {
      store.set(providerId, type);
    },
    logout: async (providerId) => {
      store.delete(providerId);
    },
  };
}

async function authorMessage(cwd: string, agentDir: string): Promise<string> {
  const host = createLiveWorkshopOperatorHost({
    cwd,
    agentDir,
    model: AUTHOR_MODEL,
    settingsDefault: "openai/gpt-4.1",
    profileDefault: "cursor/auto",
  });
  const session = host.openSession({
    profileId: WORKSHOP_AUTHOR_PROFILE_ID,
    context: createWorkshopDraftContext(emptyDraftPackage("demo")),
  });
  try {
    const events = await session.send("hello");
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type !== "error") {
      throw new Error("expected an author error event");
    }
    return error.message;
  } finally {
    session.close();
  }
}

describe("credential root split from the data directory", () => {
  it("opens the credential root and names a data-directory auth file that is not the store", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-split-home-"));
    const data = await mkdtemp(path.join(tmpdir(), "sf-split-data-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-split-cred-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-split-cwd-"));
    const operatorAuth = path.join(creds, "agent", "auth.json");
    const dataAuth = path.join(data, "agent", "auth.json");
    const prev = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
      credentialHome: process.env[CREDENTIAL_HOME_ENV],
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.STAGEFLOW_HOME = data;
    process.env[CREDENTIAL_HOME_ENV] = creds;
    resetGlobalStageflowHomeForTests();
    try {
      expect(path.resolve(data)).not.toBe(path.resolve(creds));
      expect(existsSync(dataAuth)).toBe(false);
      expect(existsSync(operatorAuth)).toBe(false);

      expect(detectPiHome(cwd)).toMatchObject({
        source: "sf_owned",
        authConfigured: false,
      });
      expect(existsSync(dataAuth)).toBe(false);

      let loginAuthPath: string | undefined;
      await loginWithApiKey(cwd, "key-provider", "sk-test-secret-marker", {
        lock: makeMutationLock(),
        createRuntime: async (authPath) => {
          loginAuthPath = authPath;
          await mkdir(path.dirname(authPath), { recursive: true });
          await writeFile(authPath, USABLE_AUTH);
          return loginRuntime();
        },
      });
      expect(loginAuthPath).toBe(operatorAuth);
      expect(await readFile(operatorAuth, "utf8")).toBe(USABLE_AUTH);
      expect(existsSync(dataAuth)).toBe(false);
      expect(detectPiHome(cwd).authConfigured).toBe(true);

      const create = vi
        .spyOn(ModelRuntime, "create")
        .mockRejectedValue(new Error("model-session-opened"));
      try {
        const opened = await authorMessage(cwd, path.join(data, "workshop-agent"));
        expect(opened).toBe("model-session-opened");
        expect(create).toHaveBeenCalledWith({
          authPath: operatorAuth,
          modelsPath: path.join(creds, "agent", "models.json"),
        });
      } finally {
        create.mockRestore();
      }
      expect(existsSync(dataAuth)).toBe(false);

      await rm(operatorAuth, { force: true });
      await mkdir(path.dirname(dataAuth), { recursive: true });
      await writeFile(dataAuth, USABLE_AUTH);

      const unused = await authorMessage(cwd, path.join(data, "workshop-agent"));
      expect(unused).toContain(operatorAuth);
      expect(unused).toContain(dataAuth);
      expect(unused).toMatch(/process data directory/i);
      expect(unused).toMatch(/is not used/i);
      expect(await readFile(dataAuth, "utf8")).toBe(USABLE_AUTH);
      expect(existsSync(operatorAuth)).toBe(false);
      expect(detectPiHome(cwd).authConfigured).toBe(false);
    } finally {
      restoreEnv("HOME", prev.HOME);
      restoreEnv("USERPROFILE", prev.USERPROFILE);
      restoreEnv("STAGEFLOW_HOME", prev.STAGEFLOW_HOME);
      restoreEnv(CREDENTIAL_HOME_ENV, prev.credentialHome);
      resetGlobalStageflowHomeForTests();
      await rm(home, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
      await rm(creds, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
