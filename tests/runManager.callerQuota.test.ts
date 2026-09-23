import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";

const temps: string[] = [];

afterEach(() => {
  clearFindProjectRootCacheForTests();
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

type AdmitFn = (
  checkoutKey: string | undefined,
  projectRoot?: string,
  callerId?: string | null,
) => {
  action: string;
  reason?: string;
  failure?: {
    code?: string;
    scope?: string;
    caller_id?: string;
    maxConcurrent?: number;
  };
};

function admit(manager: RunManager): AdmitFn {
  return (manager as unknown as { tryAdmitOrEnqueue: AdmitFn }).tryAdmitOrEnqueue.bind(
    manager,
  );
}

describe("per-caller concurrency quota", () => {
  it("queues with busy_caller_quota reason when caller is at quota and global has room", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-q-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 4,
      maxQueued: 8,
      callerQuotas: { ci: 1 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const second = tryAdmit(undefined, root, "ci");
    expect(second.action).toBe("enqueue");
    expect(second.reason).toBe("caller_quota");

    const other = tryAdmit(undefined, root, "other");
    expect(other.action).toBe("reserve");
  });

  it("rejects busy_caller_quota when caller over quota and admission queue is full", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-full-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 2,
      maxQueued: 0,
      callerQuotas: { ci: 1 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_caller_quota");
    expect(rejected.failure?.scope).toBe("caller");
    expect(rejected.failure?.caller_id).toBe("ci");
    expect(rejected.failure?.maxConcurrent).toBe(1);
  });

  it("global full still returns busy_capacity not busy_caller_quota", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-global-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 1,
      maxQueued: 0,
      callerQuotas: { ci: 10 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_capacity");
    expect(rejected.failure?.scope).toBe("global");
  });

  it("per-project cap still rejects with busy_capacity (does not queue)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-proj-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 6,
      maxConcurrentPerProject: 1,
      maxQueued: 8,
      callerQuotas: { ci: 10 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_capacity");
    expect(rejected.failure?.scope).toBe("project");
  });
});
