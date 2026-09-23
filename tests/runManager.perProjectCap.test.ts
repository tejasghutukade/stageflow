import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("per-project concurrency cap", () => {
  it("rejects second same-root run with scope project when cap is 1", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-per-proj-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([]);
    const manager = new RunManager({
      agent,
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 6,
      maxConcurrentPerProject: 1,
      maxQueued: 0,
    });

    // Force two active slots by reserving via tryAdmit path: startRun needs YAML.
    // Exercise getPerProjectCapacity + count via busyFailure shape using internal admit.
    const a = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => { action: string; failure?: { code?: string; scope?: string } };
    }).tryAdmitOrEnqueue(undefined, root);
    expect(a.action).toBe("reserve");

    const b = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => { action: string; failure?: { code?: string; scope?: string; maxConcurrent?: number } };
    }).tryAdmitOrEnqueue(undefined, root);
    expect(b.action).toBe("reject");
    expect(b.failure?.code).toBe("busy_capacity");
    expect(b.failure?.scope).toBe("project");
    expect(b.failure?.maxConcurrent).toBe(1);

    const other = path.join(root, "other");
    const c = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => { action: string };
    }).tryAdmitOrEnqueue(undefined, other);
    expect(c.action).toBe("reserve");

    const cap = manager.getPerProjectCapacity();
    expect(cap.maxConcurrent).toBe(1);
    expect(cap.projects.some((p) => p.activeCount >= 1)).toBe(true);
  });
});
