import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  INVALID_SLOT_COUNT_MESSAGE,
  parseSlotCount,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { startUiServer } from "../src/server/http.js";

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

describe("parseSlotCount", () => {
  it("rejects non-integers and values below 1", () => {
    expect(parseSlotCount(0)).toBeUndefined();
    expect(parseSlotCount(-1)).toBeUndefined();
    expect(parseSlotCount(2.5)).toBeUndefined();
    expect(parseSlotCount("3")).toBeUndefined();
    expect(parseSlotCount(null)).toBeUndefined();
    expect(parseSlotCount(undefined)).toBeUndefined();
  });

  it("accepts integers >= 1", () => {
    expect(parseSlotCount(1)).toBe(1);
    expect(parseSlotCount(6)).toBe(6);
  });
});

describe("RunManager.setMaxConcurrent", () => {
  it("throws with the shared message and leaves the prior cap in place", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cap-reject-"));
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store: createRunStore({ rootDir: root }),
      cwd: root,
      maxConcurrent: 3,
    });

    expect(() => manager.setMaxConcurrent(0)).toThrow(INVALID_SLOT_COUNT_MESSAGE);
    expect(manager.getMaxConcurrent()).toBe(3);
  });

  it("returns capacity health and persists a valid cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cap-set-"));
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store: createRunStore({ rootDir: root }),
      cwd: root,
      maxConcurrent: 3,
    });

    expect(manager.setMaxConcurrent(4)).toMatchObject({
      ok: true,
      maxConcurrent: 4,
      activeCount: 0,
      slotsAvailable: 4,
    });

    const persisted = JSON.parse(
      await readFile(path.join(storeRootFor(root), "settings.json"), "utf8"),
    ) as { maxConcurrent: number };
    expect(persisted.maxConcurrent).toBe(4);
  });
});

describe("POST /api/settings slot rule", () => {
  it("returns 400 with the shared message for maxConcurrent 0", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cap-http-400-"));
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      store: createRunStore({ rootDir: root }),
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      maxConcurrent: 2,
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const invalid = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: 0 }),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe(INVALID_SLOT_COUNT_MESSAGE);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns 200 and updated capacity health for maxConcurrent 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cap-http-200-"));
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      store: createRunStore({ rootDir: root }),
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      maxConcurrent: 2,
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const raised = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: 4 }),
      });
      expect(raised.status).toBe(200);
      expect(raised.body).toMatchObject({
        ok: true,
        maxConcurrent: 4,
        activeCount: 0,
        slotsAvailable: 4,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
