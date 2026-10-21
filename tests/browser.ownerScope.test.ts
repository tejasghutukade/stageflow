import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createContainerBrowserHost } from "../src/browser/containerBrowserHost.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { localOwnerScope, runOwnerScope } from "../src/browser/ownerScope.js";
import { acquireStageProfile } from "../src/browser/stageProfileLock.js";
import { resolveStageBrowserEnv } from "../src/browser/stageBrowserEnv.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createFakeContainerBrowsers } from "./helpers/fakeContainerBrowsers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join("/tmp", "sfos-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

const runner: BrowserRunner = async () => ({ code: 0, stdout: "" });

function setup() {
  const fake = createFakeContainerBrowsers();
  const profiles = createVolumeProfileStore();
  const audit = createMemoryAuditSink();
  const support: StageBrowserSupport = {
    host: createContainerBrowserHost({
      orchestrator: fake.orchestrator,
      endpoint: fake.endpoint,
      local: { platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") },
      pollMs: 1,
      closeWaitMs: 30,
    }),
    profiles,
    runner,
    socketRoot: path.join(root, "sock"),
    locks: createInMemoryProfileLock(),
    audit,
    ownerScope: ({ runId } = { runId: "" }) => (runId.startsWith("b-") ? "tenant-b" : "tenant-a"),
  };
  return { fake, profiles, audit, support };
}

describe("owner scope plumbing", () => {
  it("defaults to the local owner and honours a Host resolver", () => {
    expect(runOwnerScope({}, { runId: "r1" })).toBe(localOwnerScope());
    const { support } = setup();
    expect(runOwnerScope(support, { runId: "b-1" })).toBe("tenant-b");
    expect(runOwnerScope(support, { runId: "a-1" })).toBe("tenant-a");
  });

  it("opens the profile, container and audit record in the scope it is given", async () => {
    const { fake, profiles, audit, support } = setup();
    for (const [runId, scope] of [["a-1", "tenant-a"], ["b-1", "tenant-b"]] as const) {
      const runDir = path.join(root, runId);
      await mkdir(runDir, { recursive: true });
      await resolveStageBrowserEnv(support, {
        runId,
        stageId: "s",
        scope: runOwnerScope(support, { runId }),
        runDir,
        browser: { profile: "acct" },
      });
      expect(await profiles.list(scope)).toEqual(["acct"]);
      expect(await fake.orchestrator.listByLabel({ scope })).toHaveLength(1);
    }
    expect(audit.records.filter((r) => r.event === "profile_used").map((r) => (r as { scope: string }).scope)).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
  });

  it("leases the same profile name independently per scope", async () => {
    const { support } = setup();
    const base = { profile: "acct", halted: () => true };
    expect(await acquireStageProfile(support, { ...base, scope: "tenant-a", owner: { runId: "a-1", stageId: "s" } })).toBe("acquired");
    expect(await acquireStageProfile(support, { ...base, scope: "tenant-b", owner: { runId: "b-1", stageId: "s" } })).toBe("acquired");
    expect(await acquireStageProfile(support, { ...base, scope: "tenant-a", owner: { runId: "a-2", stageId: "s" } })).toBe("halted");
  });
});
