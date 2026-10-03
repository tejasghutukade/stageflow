import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalProfileLock } from "../src/browser/localProfileLock.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import type {
  ProfileLock,
  ProfileLockOptions,
} from "../src/browser/profileLock.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-browser-lock-"));
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
  make: (options?: ProfileLockOptions) => ProfileLock;
}> = [
  { name: "local", make: createLocalProfileLock },
  { name: "in-memory", make: createInMemoryProfileLock },
];

const a = { scope: "local", name: "acct" };
const ownerA = { runId: "r1", stageId: "s1" };
const ownerB = { runId: "r2", stageId: "s2" };

describe.each(implementations)("ProfileLock contract: $name", ({ make }) => {
  it("is exclusive and names the holder to a second acquirer", async () => {
    const lock = make();
    expect((await lock.acquire(a, ownerA)).status).toBe("acquired");
    const second = await lock.acquire(a, ownerB);
    expect(second).toEqual({ status: "queued", holder: ownerA });
    expect(second.status === "queued" && second.holder.runId).toBe("r1");
    expect(await lock.holder(a)).toEqual(ownerA);
  });

  it("lets the queued owner acquire after release", async () => {
    const lock = make();
    const first = await lock.acquire(a, ownerA);
    if (first.status !== "acquired") throw new Error("expected acquired");
    expect((await lock.acquire(a, ownerB)).status).toBe("queued");
    await first.release();
    expect(await lock.holder(a)).toBeUndefined();
    expect((await lock.acquire(a, ownerB)).status).toBe("acquired");
    expect(await lock.holder(a)).toEqual(ownerB);
  });

  it("release is idempotent and never frees a newer holder", async () => {
    const lock = make();
    const first = await lock.acquire(a, ownerA);
    if (first.status !== "acquired") throw new Error("expected acquired");
    await first.release();
    await first.release();
    await lock.acquire(a, ownerB);
    await first.release();
    expect(await lock.holder(a)).toEqual(ownerB);
  });

  it("re-acquire by the current holder succeeds", async () => {
    const lock = make();
    await lock.acquire(a, ownerA);
    expect((await lock.acquire(a, ownerA)).status).toBe("acquired");
  });

  it("lets two stages of the same run both acquire (join), whatever their stage ids", async () => {
    const lock = make();
    const first = await lock.acquire(a, { runId: "r1", stageId: "s1" });
    const second = await lock.acquire(a, { runId: "r1", stageId: "s2" });
    const third = await lock.acquire(a, { runId: "r1" });
    expect(first.status).toBe("acquired");
    expect(second.status).toBe("acquired");
    expect(third.status).toBe("acquired");
    expect((await lock.holder(a))?.runId).toBe("r1");
    expect((await lock.acquire(a, { runId: "r2", stageId: "s1" })).status).toBe("queued");
  });

  it("queues another run until releaseOwner({ runId }) of the holder run", async () => {
    const lock = make();
    await lock.acquire(a, { runId: "r1", stageId: "s1" });
    await lock.acquire(a, { runId: "r1", stageId: "s2" });
    const queued = await lock.acquire(a, ownerB);
    expect(queued.status).toBe("queued");
    if (queued.status === "queued") expect(queued.holder.runId).toBe("r1");
    await lock.releaseOwner({ runId: "r1" });
    expect(await lock.holder(a)).toBeUndefined();
    expect((await lock.acquire(a, ownerB)).status).toBe("acquired");
    expect((await lock.holder(a))?.runId).toBe("r2");
  });

  it("releaseOwner frees every profile of the run and no other run's", async () => {
    const lock = make();
    const b = { scope: "local", name: "other" };
    const c = { scope: "local", name: "third" };
    await lock.acquire(a, ownerA);
    await lock.acquire(b, { runId: "r1", stageId: "s9" });
    await lock.acquire(c, ownerB);
    await lock.releaseOwner({ runId: "r1" });
    expect(await lock.holder(a)).toBeUndefined();
    expect(await lock.holder(b)).toBeUndefined();
    expect((await lock.holder(c))?.runId).toBe("r2");
  });

  it("reclaims a lock whose holder run is dead on acquire", async () => {
    const live = new Set(["r1"]);
    const lock = make({ isRunLive: async (id) => live.has(id) });
    await lock.acquire(a, ownerA);
    expect((await lock.acquire(a, ownerB)).status).toBe("queued");
    live.delete("r1");
    expect((await lock.acquire(a, ownerB)).status).toBe("acquired");
    expect(await lock.holder(a)).toEqual(ownerB);
  });

  it("reclaimStale drops only locks of dead runs", async () => {
    const lock = make();
    const b = { scope: "local", name: "other" };
    await lock.acquire(a, ownerA);
    await lock.acquire(b, ownerB);
    const dropped = await lock.reclaimStale(async (id) => id === "r2");
    expect(dropped).toBe(1);
    expect(await lock.holder(a)).toBeUndefined();
    expect(await lock.holder(b)).toEqual(ownerB);
  });

  it("does not let scope A's lock block scope B", async () => {
    const lock = make();
    await lock.acquire({ scope: "tenant-a", name: "acct" }, ownerA);
    expect(
      (await lock.acquire({ scope: "tenant-b", name: "acct" }, ownerB)).status,
    ).toBe("acquired");
  });

  it("different profile names are independent", async () => {
    const lock = make();
    await lock.acquire(a, ownerA);
    expect(
      (await lock.acquire({ scope: "local", name: "other" }, ownerB)).status,
    ).toBe("acquired");
  });
});

describe("local ProfileLock", () => {
  it("survives a Host restart (a new instance sees the holder)", async () => {
    await createLocalProfileLock().acquire(a, ownerA);
    const restarted = createLocalProfileLock();
    expect(await restarted.holder(a)).toEqual(ownerA);
    expect((await restarted.acquire(a, ownerB)).status).toBe("queued");
  });

  it("only one of many concurrent acquirers wins", async () => {
    const lock = createLocalProfileLock();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createLocalProfileLock().acquire(a, { runId: `r${i}`, stageId: "s" }),
      ),
    );
    expect(results.filter((r) => r.status === "acquired")).toHaveLength(1);
    expect(await lock.holder(a)).toBeDefined();
  });
});

describe("local ProfileLock corrupt lock file", () => {
  const writeCorrupt = async (content: string) => {
    const file = path.join(home, "browser", "locks", "local", "acct.lock");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  };

  it.each(["", "not json", "{}"])("treats %j as stale on acquire", async (content) => {
    await writeCorrupt(content);
    const lock = createLocalProfileLock();
    expect((await lock.acquire(a, ownerA)).status).toBe("acquired");
    expect(await lock.holder(a)).toEqual(ownerA);
  });

  it("reclaimStale drops it", async () => {
    const file = await writeCorrupt("");
    expect(await createLocalProfileLock().reclaimStale(async () => true)).toBe(1);
    await expect(readFile(file)).rejects.toThrow();
  });
});
