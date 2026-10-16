import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_RESORT_MODEL,
  ModelCatalog,
  peekDefaultModel,
  resetModelCatalogsForTests,
  type CatalogRuntime,
} from "../src/models/catalog.js";
import { writeFactorySettings } from "../src/runtime/settingsFile.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

type FakeModel = { id: string; provider: string; name?: string; contextWindow?: number; cost?: { input: number; output: number } };

function fakeRuntime(options: {
  connected: string[];
  models: Record<string, FakeModel[]>;
  /** Models appear only after a network refresh (a live list newer than the built-in one). */
  live?: Record<string, FakeModel[]>;
  failRefresh?: boolean;
}) {
  const refreshes: Array<{ allowNetwork?: boolean; force?: boolean; providers?: readonly string[] }> = [];
  let refreshed = false;
  const runtime: CatalogRuntime = {
    getProviders: () => Object.keys({ ...options.models }).map((id) => ({ id, name: id.toUpperCase() })),
    getProviderAuthStatus: (id) => ({ configured: options.connected.includes(id) }),
    listCredentials: async () => [],
    getModels: (id) => (refreshed && id && options.live?.[id] ? options.live[id]! : options.models[id ?? ""] ?? []),
    refresh: async (refresh) => {
      refreshes.push({ ...refresh });
      if (refresh?.allowNetwork) {
        if (options.failRefresh) throw new Error("offline");
        refreshed = true;
      }
    },
  };
  return { runtime, refreshes };
}

const builtin: Record<string, FakeModel[]> = {
  openrouter: [{ id: "openai/gpt-oss", provider: "openrouter", name: "GPT OSS", contextWindow: 128000 }],
  anthropic: [{ id: "claude-sonnet", provider: "anthropic" }],
  google: [{ id: "gemini", provider: "google" }],
};

describe("model catalog", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-models-"));
    bindStageflowHomeForTests(home);
    resetModelCatalogsForTests();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const catalogFor = (runtime: CatalogRuntime, extra: Partial<ConstructorParameters<typeof ModelCatalog>[0]> = {}) =>
    new ModelCatalog({ cwd: home, createRuntime: async () => runtime, cursor: () => ({ connected: false, modelIds: [] }), ...extra });

  it("lists only connected providers, grouped, ids as provider/model", async () => {
    const { runtime } = fakeRuntime({ connected: ["openrouter", "anthropic"], models: builtin });
    const snapshot = await catalogFor(runtime).snapshot();
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["anthropic", "openrouter"]);
    expect(snapshot.models).toEqual(["anthropic/claude-sonnet", "openrouter/openai/gpt-oss"]);
    expect(snapshot.providers.find((provider) => provider.id === "openrouter")!.models[0]).toMatchObject({
      id: "openrouter/openai/gpt-oss",
      name: "GPT OSS",
      contextWindow: 128000,
      free: false,
      nativeTools: false,
    });
  });

  it("asks connected providers live and surfaces models newer than the built-in list", async () => {
    const live = { openrouter: [...builtin.openrouter!, { id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" }] };
    const { runtime, refreshes } = fakeRuntime({ connected: ["openrouter"], models: builtin, live });
    const catalog = catalogFor(runtime);
    const snapshot = await catalog.snapshot();
    expect(snapshot.models).toContain("openrouter/nvidia/nemotron-3.5-lightning:free");
    expect(snapshot.providers[0]!.models.find((model) => model.id.endsWith(":free"))!.free).toBe(true);
    expect(snapshot.providers[0]!.source).toBe("live");
    expect(refreshes.map((entry) => [entry.allowNetwork, entry.providers])).toEqual([
      [false, ["openrouter"]],
      [true, ["openrouter"]],
    ]);
    await expect(catalog.isKnown("openrouter/nvidia/nemotron-3.5-lightning:free")).resolves.toBe(true);
  });

  it("caches within the TTL and forces a provider refetch on refresh", async () => {
    let now = 1_000;
    const { runtime, refreshes } = fakeRuntime({ connected: ["openrouter"], models: builtin });
    const catalog = catalogFor(runtime, { now: () => now, ttlMs: 30_000 });
    await catalog.snapshot();
    await catalog.snapshot();
    expect(refreshes.filter((entry) => entry.allowNetwork)).toHaveLength(1);
    now += 31_000;
    await catalog.snapshot();
    expect(refreshes.filter((entry) => entry.allowNetwork)).toHaveLength(2);
    await catalog.refresh();
    const last = refreshes.filter((entry) => entry.allowNetwork).at(-1)!;
    expect(last.force).toBe(true);
  });

  it("falls back to the built-in list when the provider cannot be reached", async () => {
    const { runtime } = fakeRuntime({ connected: ["openrouter"], models: builtin, failRefresh: true });
    const snapshot = await catalogFor(runtime).snapshot();
    expect(snapshot.providers[0]).toMatchObject({ id: "openrouter", source: "fallback", error: "offline" });
    expect(snapshot.models).toEqual(["openrouter/openai/gpt-oss"]);
  });

  it("returns an empty list when nothing is connected, and still has a default", async () => {
    const { runtime } = fakeRuntime({ connected: [], models: builtin });
    const catalog = catalogFor(runtime);
    expect((await catalog.snapshot()).models).toEqual([]);
    await expect(catalog.defaultModel()).resolves.toBe(LAST_RESORT_MODEL);
  });

  it("flags unknown custom ids without rejecting them", async () => {
    const { runtime } = fakeRuntime({ connected: ["anthropic"], models: builtin });
    const catalog = catalogFor(runtime);
    await expect(catalog.isKnown("anthropic/claude-sonnet")).resolves.toBe(true);
    await expect(catalog.isKnown("acme/custom-model")).resolves.toBe(false);
    await expect(catalog.isKnown("  ")).resolves.toBe(false);
  });

  it("adds Cursor models only when Cursor is connected, marked as native-tools", async () => {
    const { runtime } = fakeRuntime({ connected: ["anthropic"], models: builtin });
    const off = await catalogFor(runtime).snapshot();
    expect(off.providers.some((provider) => provider.id === "cursor")).toBe(false);
    const on = await catalogFor(runtime, { cursor: () => ({ connected: true, modelIds: ["cursor/auto", "cursor/grok-4.7"] }) }).snapshot();
    const cursor = on.providers.find((provider) => provider.id === "cursor")!;
    expect(cursor.models.map((model) => [model.id, model.nativeTools])).toEqual([
      ["cursor/auto", true],
      ["cursor/grok-4.7", true],
    ]);
  });

  describe("default model", () => {
    it("prefers stageflow settings, then the last-resort model when connected, then a free model, then the first", async () => {
      const connected = fakeRuntime({
        connected: ["openrouter"],
        models: { openrouter: [{ id: "zzz", provider: "openrouter" }, { id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" }] },
      });
      await expect(catalogFor(connected.runtime).defaultModel()).resolves.toBe(LAST_RESORT_MODEL);

      const free = fakeRuntime({
        connected: ["openrouter"],
        models: { openrouter: [{ id: "aaa", provider: "openrouter" }, { id: "meta/free:free", provider: "openrouter" }] },
      });
      await expect(catalogFor(free.runtime).defaultModel()).resolves.toBe("openrouter/meta/free:free");

      const paid = fakeRuntime({ connected: ["anthropic"], models: builtin });
      await expect(catalogFor(paid.runtime).defaultModel()).resolves.toBe("anthropic/claude-sonnet");
    });

    it("never defaults to a native-tools provider while another model exists", async () => {
      const { runtime } = fakeRuntime({ connected: ["anthropic"], models: builtin });
      const catalog = catalogFor(runtime, { cursor: () => ({ connected: true, modelIds: ["cursor/auto"] }) });
      await expect(catalog.defaultModel()).resolves.toBe("anthropic/claude-sonnet");
    });

    it("uses the Settings workshop model over the catalog pick, and peeks it synchronously", async () => {
      writeFactorySettings(home, { workshopModel: "acme/custom" });
      const { runtime } = fakeRuntime({ connected: ["anthropic"], models: builtin });
      const catalog = catalogFor(runtime);
      await expect(catalog.defaultModel()).resolves.toBe("acme/custom");
      expect(peekDefaultModel()).toBe("acme/custom");
    });
  });

  it("serves the last good list when a rebuild fails", async () => {
    let fail = false;
    let now = 0;
    const { runtime } = fakeRuntime({ connected: ["anthropic"], models: builtin });
    const catalog = new ModelCatalog({
      cwd: home,
      now: () => now,
      ttlMs: 1,
      cursor: () => ({ connected: false, modelIds: [] }),
      createRuntime: async () => {
        if (fail) throw new Error("auth store unreadable");
        return runtime;
      },
    });
    const first = await catalog.snapshot();
    fail = true;
    now += 10;
    await expect(catalog.snapshot()).resolves.toEqual(first);
  });
});

vi.setConfig({ testTimeout: 15_000 });
