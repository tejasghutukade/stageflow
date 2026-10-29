import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { createProfileCatalog, ProfileCatalogError, type ProfileCatalogDeps } from "../src/browser/profileCatalog.js";
import { createProfileHostHints } from "../src/browser/profileHostHint.js";
import { createProfileMetaStore, stageSites } from "../src/browser/profileMeta.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { handleBrowserProfileRoutes } from "../src/server/browserProfileRoutes.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-profiles-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

async function setup(over: Partial<ProfileCatalogDeps> = {}) {
  const profiles = createLocalProfileStore();
  const locks = createInMemoryProfileLock();
  const hints = createProfileHostHints();
  const meta = createProfileMetaStore();
  const closed: string[] = [];
  const catalog = createProfileCatalog({
    scope: "local",
    profiles,
    locks,
    isRunLive: async () => true,
    hints,
    meta,
    auditLastUsed: async () => ({ work: "2030-01-01T00:00:00.000Z" }),
    pinnedByConfig: new Set(),
    closeProfileSession: async (p) => void closed.push(p.key.name),
    ...over,
  });
  const handle = (name: string) => profiles.open({ scope: "local", name });
  return { catalog, profiles, locks, hints, meta, closed, handle };
}

describe("profile metadata", () => {
  it("collects the sites a stage works with, without schemes, ports or wildcards", () => {
    expect(
      stageSites({
        profile: "p",
        check: { url: "https://Secure.Indeed.com/settings/account?x=1", logged_in_url: "x" },
        login_url: "https://secure.indeed.com/auth",
        allow_domains: ["*.indeed.com", "indeed.com"],
      }),
    ).toEqual(["secure.indeed.com", "indeed.com"]);
    expect(stageSites(undefined)).toEqual([]);
  });

  it("merges records: sites are unioned, times replaced, and nothing secret is kept", async () => {
    const { meta, handle } = await setup();
    const h = await handle("acct");
    await meta.record(h, { sites: ["a.test"], login_at: "2030-01-01T00:00:00.000Z", where: "own_chrome" });
    await meta.record(h, { sites: ["b.test", "a.test"], verified_at: "2030-02-01T00:00:00.000Z" });
    expect(await meta.get(h)).toEqual({
      sites: ["a.test", "b.test"],
      last_login_at: "2030-01-01T00:00:00.000Z",
      last_verified_at: "2030-02-01T00:00:00.000Z",
      login_where: "own_chrome",
    });
    await meta.clear(h);
    expect(await meta.get(h)).toBeUndefined();
  });

  it("keeps metadata in memory for a profile with no folder", async () => {
    const volume = await createVolumeProfileStore().open({ scope: "local", name: "v" });
    const meta = createProfileMetaStore();
    await meta.record(volume, { sites: ["x.test"] });
    expect((await meta.get(volume))?.sites).toEqual(["x.test"]);
  });
});

describe("profile catalog", () => {
  it("lists each login with its sites, where it was made, and why it is pinned", async () => {
    const t = await setup({ pinnedByConfig: new Set(["cfg"]) });
    for (const name of ["work", "learned", "cfg", "plain"]) await t.handle(name);
    await t.meta.record(await t.handle("work"), { sites: ["site.test"], login_at: "2030-01-02T00:00:00.000Z", where: "host_browser" });
    await t.hints.set(await t.handle("learned"), { mode: "attach", reason: "blocked" });
    await t.locks.acquire({ scope: "local", name: "plain" }, { runId: "run-7", stageId: "s" });
    const byName = Object.fromEntries((await t.catalog.list()).map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["cfg", "learned", "plain", "work"]);
    expect(byName.work).toMatchObject({ sites: ["site.test"], login_where: "host_browser", last_login_at: "2030-01-02T00:00:00.000Z", pinned: null, in_use: null });
    expect(byName.work!.last_used_at).not.toBeNull();
    expect(byName.learned!.pinned).toMatchObject({ by: "learned", reason: "blocked" });
    expect(byName.cfg!.pinned).toMatchObject({ by: "config" });
    expect(byName.plain!.in_use).toEqual({ run_id: "run-7", stage_id: "s", live: true });
    expect(JSON.stringify(byName)).not.toContain(home);
  });

  it("reports a missing profile and rejects an invalid name", async () => {
    const t = await setup();
    await expect(t.catalog.get("nope")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(t.catalog.get("../x")).rejects.toThrow();
  });

  it("deletes the saved login, its pin and metadata, and closes the session first", async () => {
    const t = await setup();
    const h = await t.handle("acct");
    await t.meta.record(h, { sites: ["s.test"] });
    await t.hints.set(h, { mode: "attach", reason: "x" });
    await t.catalog.remove("acct");
    expect(t.closed).toEqual(["acct"]);
    await expect(stat(h.profileDir!)).rejects.toThrow();
    expect(await t.profiles.list("local")).toEqual([]);
    expect(await t.hints.get(h)).toBeUndefined();
    expect(await t.meta.get(h)).toBeUndefined();
    // the profile lock was released again
    const again = await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "r", stageId: "s" });
    expect(again.status).not.toBe("queued");
  });

  it("refuses to delete a profile a run is using, and leaves it untouched", async () => {
    const t = await setup();
    const h = await t.handle("acct");
    await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "run-9", stageId: "scrape" });
    await expect(t.catalog.remove("acct")).rejects.toMatchObject({ code: "profile_busy", status: 409 });
    expect(await t.profiles.list("local")).toEqual(["acct"]);
    expect(t.closed).toEqual([]);
    await stat(h.profileDir!);
  });

  it("unpins a learned profile, and says why it cannot unpin a config-pinned or unpinned one", async () => {
    const t = await setup({ pinnedByConfig: new Set(["cfg"]) });
    for (const n of ["learned", "cfg", "plain"]) await t.handle(n);
    await t.hints.set(await t.handle("learned"), { mode: "attach", reason: "blocked" });
    const after = await t.catalog.unpin("learned");
    expect(after.pinned).toBeNull();
    await expect(t.catalog.unpin("cfg")).rejects.toMatchObject({ code: "pinned_by_config" });
    await expect(t.catalog.unpin("plain")).rejects.toMatchObject({ code: "not_pinned" });
  });
});

describe("browser profile routes", () => {
  function fakeRes() {
    const sent: Array<{ status: number; body: unknown }> = [];
    const json = (_res: ServerResponse, status: number, body: unknown) => void sent.push({ status, body });
    return { sent, json, res: {} as ServerResponse };
  }

  it("lists, shows, deletes and unpins, and answers errors with a code", async () => {
    const t = await setup();
    await t.handle("acct");
    await t.hints.set(await t.handle("acct"), { mode: "attach", reason: "blocked" });
    const { sent, json, res } = fakeRes();
    expect(await handleBrowserProfileRoutes("GET", "/api/browser/profiles", t.catalog, res, json)).toBe(true);
    expect((sent[0]!.body as { profiles: unknown[] }).profiles).toHaveLength(1);
    await handleBrowserProfileRoutes("GET", "/api/browser/profiles/acct", t.catalog, res, json);
    expect(sent[1]).toMatchObject({ status: 200, body: { name: "acct", pinned: { by: "learned" } } });
    await handleBrowserProfileRoutes("DELETE", "/api/browser/profiles/acct/pin", t.catalog, res, json);
    expect(sent[2]).toMatchObject({ status: 200, body: { pinned: null } });
    await handleBrowserProfileRoutes("DELETE", "/api/browser/profiles/acct/pin", t.catalog, res, json);
    expect(sent[3]).toMatchObject({ status: 409, body: { code: "not_pinned" } });
    await handleBrowserProfileRoutes("DELETE", "/api/browser/profiles/acct", t.catalog, res, json);
    expect(sent[4]).toMatchObject({ status: 200, body: { deleted: true, name: "acct" } });
    await handleBrowserProfileRoutes("GET", "/api/browser/profiles/acct", t.catalog, res, json);
    expect(sent[5]).toMatchObject({ status: 404, body: { code: "not_found" } });
    await handleBrowserProfileRoutes("GET", "/api/browser/profiles/..%2Fx", t.catalog, res, json);
    expect(sent[6]!.status).toBe(400);
  });

  it("ignores other paths and unsupported methods", async () => {
    const t = await setup();
    const { sent, json, res } = fakeRes();
    expect(await handleBrowserProfileRoutes("GET", "/api/browser/other", t.catalog, res, json)).toBe(false);
    expect(await handleBrowserProfileRoutes("POST", "/api/browser/profiles", t.catalog, res, json)).toBe(false);
    expect(await handleBrowserProfileRoutes("PUT", "/api/browser/profiles/acct", t.catalog, res, json)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("is a ProfileCatalogError that carries an HTTP status", () => {
    const e = new ProfileCatalogError("x", "not_found", 404);
    expect(e).toMatchObject({ code: "not_found", status: 404 });
  });
});
