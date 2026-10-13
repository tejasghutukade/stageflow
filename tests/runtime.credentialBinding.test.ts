import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPiHome } from "../src/agent/providerAuth.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  ensureSfOwnedAuthStore,
  isUsableAuthFile,
  resolveCredentialBinding,
  sfOwnedAuthPath,
  STAGEFLOW_AGENT_AUTH_PATH_ENV,
} from "../src/runtime/credentialBinding.js";
import { withResolvedAuthPath } from "../src/runtime/stageRoots.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";
import {
  readCredentialSourceFromFile,
  writeCredentialSourceToContext,
  writeCredentialSourceToFile,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { resolveProjectContext } from "../src/project/resolveProjectContext.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";

async function withSavedProcessEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
    [CREDENTIAL_HOME_ENV]: process.env[CREDENTIAL_HOME_ENV],
    [STAGEFLOW_AGENT_AUTH_PATH_ENV]: process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV],
  };
  try {
    return await fn();
  } finally {
    restoreEnv("HOME", prev.HOME);
    restoreEnv("USERPROFILE", prev.USERPROFILE);
    restoreEnv("STAGEFLOW_HOME", prev.STAGEFLOW_HOME);
    restoreEnv(CREDENTIAL_HOME_ENV, prev[CREDENTIAL_HOME_ENV]);
    restoreEnv(
      STAGEFLOW_AGENT_AUTH_PATH_ENV,
      prev[STAGEFLOW_AGENT_AUTH_PATH_ENV],
    );
    resetGlobalStageflowHomeForTests();
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("resolveCredentialBinding", () => {
  it("ensures SF-owned auth store under global home", async () => {
    await withIsolatedHome(async (home) => {
      const authPath = ensureSfOwnedAuthStore();
      expect(authPath).toBe(sfOwnedAuthPath());
      expect(authPath.startsWith(path.join(home, ".stageflow"))).toBe(true);
      expect(isUsableAuthFile(authPath)).toBe(false);
    });
  });

  it("provisional sf_owned when unset even if a legacy Pi-home file exists elsewhere", async () => {
    await withIsolatedHome(async (home) => {
      const legacyPi = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(legacyPi), { recursive: true });
      await writeFile(
        legacyPi,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );

      const binding = resolveCredentialBinding(home);
      expect(binding).toEqual({
        source: "sf_owned",
        authPath: sfOwnedAuthPath(),
        provisional: true,
      });
      expect(readCredentialSourceFromFile(home)).toBeUndefined();
    });
  });

  it("provisional sf_owned when unset", async () => {
    await withIsolatedHome(async (home) => {
      const binding = resolveCredentialBinding(home);
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(true);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
    });
  });

  it("persisted sf_owned wins even when Pi-home is usable", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(piHome), { recursive: true });
      await writeFile(
        piHome,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );
      writeCredentialSourceToFile(home, "sf_owned");

      const binding = resolveCredentialBinding(home);
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(false);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
    });
  });

  it("legacy pi_home on disk normalizes to sf_owned binding", async () => {
    await withIsolatedHome(async (home) => {
      await mkdir(storeRootFor(home), { recursive: true });
      await writeFile(
        path.join(storeRootFor(home), "settings.json"),
        `${JSON.stringify({ credentialSource: "pi_home" }, null, 2)}\n`,
      );

      const binding = resolveCredentialBinding(home);
      expect(binding).toEqual({
        source: "sf_owned",
        authPath: sfOwnedAuthPath(),
        provisional: false,
      });
      expect(readCredentialSourceFromFile(home)).toBe("sf_owned");
    });
  });

  it("AE4: sf_owned auth is not under git-root project store", async () => {
    await withIsolatedHome(async (home) => {
      const { nested, cleanup } = await initTempGitRepo();
      try {
        writeCredentialSourceToContext(resolveProjectContext(nested), "sf_owned");
        const binding = resolveCredentialBinding(nested);
        expect(binding.authPath).toBe(path.join(home, ".stageflow", "agent", "auth.json"));
        expect(binding.authPath.startsWith(storeRootFor(nested))).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  it("uses host ~/.stageflow when the data directory differs and the override is unset", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-cred-home-"));
    const data = await mkdtemp(path.join(tmpdir(), "sf-cred-data-"));
    await withSavedProcessEnv(async () => {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.STAGEFLOW_HOME = data;
      delete process.env[CREDENTIAL_HOME_ENV];
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = path.join(
        data,
        "agent",
        "auth.json",
      );
      resetGlobalStageflowHomeForTests();
      delete process.env[CREDENTIAL_HOME_ENV];

      const binding = resolveCredentialBinding(home);
      expect(binding.authPath).toBe(
        path.join(home, ".stageflow", "agent", "auth.json"),
      );
      expect(existsSync(path.join(data, "agent", "auth.json"))).toBe(false);
      expect(binding.source).toBe("sf_owned");
    });
    await rm(home, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  it("uses STAGEFLOW_CREDENTIAL_HOME as the auth directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "sf-cred-data-"));
    const override = await mkdtemp(path.join(tmpdir(), "sf-cred-override-"));
    await withSavedProcessEnv(async () => {
      process.env.STAGEFLOW_HOME = data;
      resetGlobalStageflowHomeForTests();
      process.env[CREDENTIAL_HOME_ENV] = override;

      const binding = resolveCredentialBinding(data);
      expect(binding.authPath).toBe(path.join(override, "agent", "auth.json"));
      expect(binding.source).toBe("sf_owned");
    });
    await rm(data, { recursive: true, force: true });
    await rm(override, { recursive: true, force: true });
  });

  it("honors a new credential override after resetGlobalStageflowHomeForTests", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "sf-cred-data-"));
    const first = await mkdtemp(path.join(tmpdir(), "sf-cred-first-"));
    const second = await mkdtemp(path.join(tmpdir(), "sf-cred-second-"));
    await withSavedProcessEnv(async () => {
      process.env.STAGEFLOW_HOME = data;
      resetGlobalStageflowHomeForTests();
      process.env[CREDENTIAL_HOME_ENV] = first;
      const pinned = sfOwnedAuthPath();
      expect(pinned).toBe(path.join(first, "agent", "auth.json"));

      process.env[CREDENTIAL_HOME_ENV] = second;
      expect(sfOwnedAuthPath()).toBe(pinned);

      resetGlobalStageflowHomeForTests();
      process.env[CREDENTIAL_HOME_ENV] = second;
      expect(sfOwnedAuthPath()).toBe(path.join(second, "agent", "auth.json"));
    });
    await rm(data, { recursive: true, force: true });
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  it("does not bind a usable auth file left in the data directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-cred-home-"));
    const data = await mkdtemp(path.join(tmpdir(), "sf-cred-data-"));
    const dataAuth = path.join(data, "agent", "auth.json");
    await mkdir(path.dirname(dataAuth), { recursive: true });
    await writeFile(
      dataAuth,
      JSON.stringify({ openai: { type: "api_key", key: "x" } }),
    );
    await withSavedProcessEnv(async () => {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.STAGEFLOW_HOME = data;
      process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV] = dataAuth;
      resetGlobalStageflowHomeForTests();
      delete process.env[CREDENTIAL_HOME_ENV];

      const binding = resolveCredentialBinding(home);
      expect(isUsableAuthFile(dataAuth)).toBe(true);
      expect(binding.authPath).toBe(
        path.join(home, ".stageflow", "agent", "auth.json"),
      );
      expect(binding.authPath).not.toBe(dataAuth);
    });
    await rm(home, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  it("pins withIsolatedHome and a private STAGEFLOW_HOME to that directory", async () => {
    await withIsolatedHome(async (home) => {
      writeCredentialSourceToFile(home, "sf_owned");
      const binding = resolveCredentialBinding(home);
      expect(binding.authPath).toBe(
        path.join(home, ".stageflow", "agent", "auth.json"),
      );
      expect(binding.source).toBe("sf_owned");
      expect(readCredentialSourceFromFile(home)).toBe("sf_owned");
      const raw = JSON.parse(
        await readFile(path.join(home, ".stageflow", "settings.json"), "utf8"),
      ) as { credentialSource?: string };
      expect(raw.credentialSource).toBe("sf_owned");
    });

    const home = await mkdtemp(path.join(tmpdir(), "sf-cred-home-"));
    const privateDir = await mkdtemp(path.join(tmpdir(), "sf-cred-private-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-cred-cwd-"));
    try {
      await withSavedProcessEnv(async () => {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        process.env.STAGEFLOW_HOME = privateDir;
        resetGlobalStageflowHomeForTests();
        writeCredentialSourceToFile(cwd, "sf_owned");
        const binding = resolveCredentialBinding(cwd);
        expect(binding.authPath).toBe(path.join(privateDir, "agent", "auth.json"));
        expect(binding.authPath.startsWith(home)).toBe(false);
        expect(binding.source).toBe("sf_owned");
        expect(readCredentialSourceFromFile(cwd)).toBe("sf_owned");
        const raw = JSON.parse(
          await readFile(path.join(cwd, ".stageflow", "settings.json"), "utf8"),
        ) as { credentialSource?: string };
        expect(raw.credentialSource).toBe("sf_owned");
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(privateDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves a missing operator auth file absent on read, and ensure still creates it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-cred-home-"));
    const data = await mkdtemp(path.join(tmpdir(), "sf-cred-data-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-cred-root-"));
    const operatorAuth = path.join(creds, "agent", "auth.json");
    const dataAuth = path.join(data, "agent", "auth.json");
    await mkdir(path.dirname(dataAuth), { recursive: true });
    const dataAuthBody = `${JSON.stringify({
      openai: { type: "api_key", key: "data-only" },
    })}\n`;
    await writeFile(dataAuth, dataAuthBody);
    try {
      await withSavedProcessEnv(async () => {
        const prevWorker = process.env[SF_STAGE_WORKER];
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        process.env.STAGEFLOW_HOME = data;
        process.env[CREDENTIAL_HOME_ENV] = creds;
        delete process.env[SF_STAGE_WORKER];
        resetGlobalStageflowHomeForTests();
        try {
          expect(existsSync(operatorAuth)).toBe(false);
          const binding = resolveCredentialBinding(home);
          expect(binding.authPath).toBe(operatorAuth);
          expect(existsSync(operatorAuth)).toBe(false);
          detectPiHome(home);
          expect(existsSync(operatorAuth)).toBe(false);
          const stageRoots = withResolvedAuthPath(
            {
              mode: "unbound",
              cwd: home,
              runWorkspaceDir: data,
              agentDir: path.join(data, "pi-agent"),
            },
            home,
          );
          expect(stageRoots.authPath).toBe(operatorAuth);
          expect(existsSync(operatorAuth)).toBe(false);
          expect(await readFile(dataAuth, "utf8")).toBe(dataAuthBody);

          const created = ensureSfOwnedAuthStore();
          expect(created).toBe(operatorAuth);
          expect(await readFile(operatorAuth, "utf8")).toBe("{}\n");
          expect(await readFile(dataAuth, "utf8")).toBe(dataAuthBody);
        } finally {
          if (prevWorker === undefined) delete process.env[SF_STAGE_WORKER];
          else process.env[SF_STAGE_WORKER] = prevWorker;
        }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
      await rm(creds, { recursive: true, force: true });
    }
  });
});
