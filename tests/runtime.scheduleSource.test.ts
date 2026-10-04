import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/runstore/createStore.js";
import { ScheduleSource } from "../src/runtime/scheduleSource.js";
import type { TriggerFireEvent } from "../src/runtime/triggerPort.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const everyMinuteFixture = path.join(fixtures, "triggers", "schedule-every-minute.trigger.yaml");
const disabledFixture = path.join(fixtures, "triggers", "schedule-disabled.trigger.yaml");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");

async function seedCatalog(root: string, triggerFixturePaths: string[]): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
  for (const fixturePath of triggerFixturePaths) {
    await writeFile(
      path.join(root, "triggers", path.basename(fixturePath)),
      await readFile(fixturePath, "utf8"),
    );
  }
}

function makeClock(initial: string) {
  let current = new Date(initial);
  return {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}

describe("ScheduleSource", () => {
  it("seeds next_run_at for a new schedule trigger without firing", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, [everyMinuteFixture]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const clock = makeClock("2026-01-01T00:00:00.000Z");
      const source = new ScheduleSource({ store, cwd: root, now: clock.now });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);

      expect(onFire).not.toHaveBeenCalled();
      const record = await store.getTrigger("schedule-every-minute");
      expect(record?.next_run_at).toBeDefined();
      expect(new Date(record!.next_run_at!).getTime()).toBeGreaterThan(clock.now().getTime());
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fires exactly once for a due trigger and advances next_run_at to a future time", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, [everyMinuteFixture]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const clock = makeClock("2026-01-01T00:00:00.000Z");
      const source = new ScheduleSource({ store, cwd: root, now: clock.now });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);
      expect(onFire).not.toHaveBeenCalled();

      // Force the seeded next_run_at far into the past to simulate a due fire.
      await store.setTriggerNextRun("schedule-every-minute", "2025-01-01T00:00:00.000Z");
      clock.set("2026-06-01T12:00:00.000Z");

      await source.tick(onFire);

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith({ triggerId: "schedule-every-minute" });
      const record = await store.getTrigger("schedule-every-minute");
      expect(new Date(record!.next_run_at!).getTime()).toBeGreaterThan(clock.now().getTime());
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("does not fire a trigger that is not yet due", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, [everyMinuteFixture]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const clock = makeClock("2026-01-01T00:00:00.000Z");
      const source = new ScheduleSource({ store, cwd: root, now: clock.now });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);
      const seeded = await store.getTrigger("schedule-every-minute");
      expect(seeded?.next_run_at).toBeDefined();

      clock.set("2026-01-01T00:00:10.000Z"); // still within the same minute
      await source.tick(onFire);

      expect(onFire).not.toHaveBeenCalled();
      const record = await store.getTrigger("schedule-every-minute");
      expect(record?.next_run_at).toBe(seeded?.next_run_at);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("skips a disabled schedule trigger entirely: never seeded, never fires", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, [disabledFixture]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const clock = makeClock("2026-01-01T00:00:00.000Z");
      const source = new ScheduleSource({ store, cwd: root, now: clock.now });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire);

      expect(onFire).not.toHaveBeenCalled();
      expect(await store.getTrigger("schedule-disabled")).toBeNull();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fires a recurring cron the expected number of times across several ticks, never more", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root, [everyMinuteFixture]);
      clearFindProjectRootCacheForTests();

      const store = createRunStore({ rootDir: await mkdtempHome() });
      const clock = makeClock("2026-01-01T00:00:00.000Z");
      const source = new ScheduleSource({ store, cwd: root, now: clock.now });
      const onFire = vi.fn(async (_event: TriggerFireEvent) => {});

      await source.tick(onFire); // seed: next_run_at -> 00:01:00
      expect(onFire).not.toHaveBeenCalled();

      clock.set("2026-01-01T00:01:00.000Z"); // exactly due
      await source.tick(onFire); // fires once, next -> 00:02:00
      expect(onFire).toHaveBeenCalledTimes(1);

      clock.set("2026-01-01T00:01:30.000Z"); // not yet due
      await source.tick(onFire);
      expect(onFire).toHaveBeenCalledTimes(1);

      clock.set("2026-01-01T00:02:00.000Z"); // due again
      await source.tick(onFire); // fires once more, next -> 00:03:00
      expect(onFire).toHaveBeenCalledTimes(2);

      const record = await store.getTrigger("schedule-every-minute");
      expect(record?.next_run_at).toBe("2026-01-01T00:03:00.000Z");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

async function mkdtempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sf-schedule-source-home-"));
}
