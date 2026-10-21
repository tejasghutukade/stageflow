import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryProfileStore } from "../src/browser/memoryProfileStore.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import {
  InvalidProfileKeyError,
  LOCAL_BROWSER_SCOPE,
  type ProfileStore,
} from "../src/browser/profileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-browser-store-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

const implementations: Array<{
  name: string;
  make: () => ProfileStore;
  onDisk: boolean;
}> = [
  { name: "local", make: createLocalProfileStore, onDisk: true },
  { name: "in-memory", make: createInMemoryProfileStore, onDisk: false },
];

describe.each(implementations)("ProfileStore contract: $name", ({ make, onDisk }) => {
  const badNames = [
    "",
    ".",
    "..",
    "...",
    "../x",
    "a/b",
    "a\\b",
    "/etc/passwd",
    ".hidden",
    "a..b",
    "a\0b",
    "has space",
    "x".repeat(65),
  ];

  it.each(badNames)("rejects profile name %j", async (name) => {
    const store = make();
    await expect(store.open({ scope: LOCAL_BROWSER_SCOPE, name })).rejects.toBeInstanceOf(
      InvalidProfileKeyError,
    );
    await expect(store.delete({ scope: LOCAL_BROWSER_SCOPE, name })).rejects.toBeInstanceOf(
      InvalidProfileKeyError,
    );
  });

  it("rejects bad scopes", async () => {
    const store = make();
    for (const scope of ["", "..", "../a", "a/b"]) {
      await expect(store.open({ scope, name: "p" })).rejects.toBeInstanceOf(
        InvalidProfileKeyError,
      );
      await expect(store.list(scope)).rejects.toBeInstanceOf(InvalidProfileKeyError);
      await expect(store.deleteScope(scope)).rejects.toBeInstanceOf(InvalidProfileKeyError);
    }
  });

  it("accepts a normal name and returns distinct profile and state dirs", async () => {
    const store = make();
    const handle = await store.open({ scope: LOCAL_BROWSER_SCOPE, name: "my-login_1.v2" });
    expect(handle.key).toEqual({ scope: LOCAL_BROWSER_SCOPE, name: "my-login_1.v2" });
    expect(handle.profileDir).not.toBe(handle.stateDir);
  });

  it("open is idempotent", async () => {
    const store = make();
    const a = await store.open({ scope: LOCAL_BROWSER_SCOPE, name: "p" });
    const b = await store.open({ scope: LOCAL_BROWSER_SCOPE, name: "p" });
    expect(b.profileDir).toBe(a.profileDir);
    expect(await store.list(LOCAL_BROWSER_SCOPE)).toEqual(["p"]);
  });

  it("lists and deletes per scope", async () => {
    const store = make();
    await store.open({ scope: "a", name: "one" });
    await store.open({ scope: "a", name: "two" });
    await store.open({ scope: "b", name: "one" });
    expect(await store.list("a")).toEqual(["one", "two"]);
    expect(await store.list("b")).toEqual(["one"]);
    expect(await store.list("empty")).toEqual([]);

    await store.delete({ scope: "a", name: "one" });
    expect(await store.list("a")).toEqual(["two"]);
    expect(await store.list("b")).toEqual(["one"]);
    await store.delete({ scope: "a", name: "missing" });
  });

  it("deleteScope removes only that scope", async () => {
    const store = make();
    await store.open({ scope: "a", name: "one" });
    await store.open({ scope: "a", name: "two" });
    await store.open({ scope: "b", name: "one" });
    await store.deleteScope("a");
    expect(await store.list("a")).toEqual([]);
    expect(await store.list("b")).toEqual(["one"]);
    await store.deleteScope("never-existed");
  });

  it("scope A cannot reach scope B's profile by name or path", async () => {
    const store = make();
    const b = await store.open({ scope: "b", name: "secret" });
    const a = await store.open({ scope: "a", name: "secret" });
    expect(a.profileDir).not.toBe(b.profileDir);
    expect(a.stateDir).not.toBe(b.stateDir);
    expect(await store.list("a")).toEqual(["secret"]);

    await store.delete({ scope: "a", name: "secret" });
    expect(await store.list("b")).toEqual(["secret"]);

    const crafted = ["../b/secret", "../../b/secret", b.profileDir, b.stateDir];
    for (const name of crafted) {
      await expect(store.open({ scope: "a", name })).rejects.toBeInstanceOf(
        InvalidProfileKeyError,
      );
      await expect(store.delete({ scope: "a", name })).rejects.toBeInstanceOf(
        InvalidProfileKeyError,
      );
    }
    expect(await store.list("b")).toEqual(["secret"]);
  });

  if (onDisk) {
    it("creates profiles under the stageflow home with owner-only permissions", async () => {
      const store = make();
      const handle = await store.open({ scope: LOCAL_BROWSER_SCOPE, name: "p" });
      const root = path.join(await import("node:fs/promises").then((m) => m.realpath(home)), "browser");
      for (const dir of [handle.profileDir, handle.stateDir]) {
        const real = await import("node:fs/promises").then((m) => m.realpath(dir));
        expect(real.startsWith(root + path.sep)).toBe(true);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
      expect((await stat(path.dirname(handle.profileDir))).mode & 0o777).toBe(0o700);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    });
  }
});
