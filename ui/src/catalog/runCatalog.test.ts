import { describe, expect, it } from "vitest";
import { createMemorySource } from "./memorySource";
import { createRunCatalog, type CatalogScheduler } from "./runCatalog";
import { bucketViews, runsFilterCounts, runsForTaskView, waitingView } from "./views";
import type { RunSummary } from "../api";

function summary(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id">,
): RunSummary {
  return {
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

function manualScheduler(): {
  scheduler: CatalogScheduler;
  next(): Promise<void>;
} {
  let tick: (() => void | Promise<void>) | undefined;
  return {
    scheduler: {
      every(_intervalMs, fn) {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
    },
    async next() {
      if (!tick) throw new Error("catalog is not scheduled");
      await tick();
    },
  };
}

describe("run catalog", () => {
  it("AE5: two poll ticks leave the waiting view reflecting the second listing", async () => {
    const first = [
      summary({
        run_id: "wait-1",
        waiting_stage_id: "clarify",
      }),
    ];
    const second = [
      summary({
        run_id: "wait-2",
        waiting_stage_id: "review",
      }),
    ];
    const source = createMemorySource({ listings: [first, second] });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    await catalog.start();
    expect(waitingView(catalog.getState().snapshot).map((run) => run.run_id)).toEqual(
      ["wait-1"],
    );

    await clock.next();
    expect(waitingView(catalog.getState().snapshot).map((run) => run.run_id)).toEqual(
      ["wait-2"],
    );
    expect(source.listingReads).toBe(2);
  });

  it("one catalog with three subscribers issues one listing read per tick", async () => {
    const source = createMemorySource({
      listings: [[summary({ run_id: "r1" })], [summary({ run_id: "r2" })]],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });
    let notifications = 0;
    catalog.subscribe(() => {
      notifications += 1;
    });
    catalog.subscribe(() => {
      notifications += 1;
    });
    catalog.subscribe(() => {
      notifications += 1;
    });

    await catalog.start();
    expect(source.listingReads).toBe(1);
    expect(notifications).toBe(3);

    await clock.next();
    expect(source.listingReads).toBe(2);
    expect(notifications).toBe(6);
  });

  it("a failed listing read sets the error and leaves the previous snapshot", async () => {
    const first = [summary({ run_id: "kept", waiting_stage_id: "ask" })];
    const source = createMemorySource({
      listings: [first, new Error("listing down")],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    await catalog.start();
    expect(catalog.getState().error).toBeNull();
    expect(catalog.getState().snapshot.runs).toEqual(first);

    await clock.next();
    expect(catalog.getState().error).toBe("listing down");
    expect(catalog.getState().snapshot.runs).toEqual(first);
  });

  it("a subsequent successful read clears the error", async () => {
    const first = [summary({ run_id: "a" })];
    const recovered = [summary({ run_id: "b" })];
    const source = createMemorySource({
      listings: [first, new Error("listing down"), recovered],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    await catalog.start();
    await clock.next();
    expect(catalog.getState().error).toBe("listing down");

    await clock.next();
    expect(catalog.getState().error).toBeNull();
    expect(catalog.getState().snapshot.runs).toEqual(recovered);
  });

  it("stopping the catalog issues no further reads", async () => {
    const source = createMemorySource({
      listings: [
        [summary({ run_id: "one" })],
        [summary({ run_id: "two" })],
        [summary({ run_id: "three" })],
      ],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    await catalog.start();
    await clock.next();
    expect(source.listingReads).toBe(2);
    expect(source.capacityReads).toBe(2);

    catalog.stop();
    await expect(clock.next()).rejects.toThrow("catalog is not scheduled");
    expect(source.listingReads).toBe(2);
    expect(source.capacityReads).toBe(2);
  });

  it("AE4: Today/Runs/Tasks-style subscribers issue one listing read per tick", async () => {
    const listing = [
      summary({
        run_id: "r1",
        task_id: "task-a",
        waiting_stage_id: "ask",
      }),
    ];
    const source = createMemorySource({ listings: [listing, listing] });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    catalog.subscribe(() => {
      bucketViews(catalog.getState().snapshot);
    });
    catalog.subscribe(() => {
      runsFilterCounts(catalog.getState().snapshot);
    });
    catalog.subscribe(() => {
      runsForTaskView(catalog.getState().snapshot, "task-a");
    });

    await catalog.start();
    expect(source.listingReads).toBe(1);
    expect(source.capacityReads).toBe(1);
    expect(waitingView(catalog.getState().snapshot)).toHaveLength(1);

    await clock.next();
    expect(source.listingReads).toBe(2);
    expect(source.capacityReads).toBe(2);
  });

  it("refresh issues one listing read without waiting for the scheduler", async () => {
    const source = createMemorySource({
      listings: [[summary({ run_id: "a" })], [summary({ run_id: "b" })]],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    await catalog.start();
    expect(source.listingReads).toBe(1);

    await catalog.refresh();
    expect(source.listingReads).toBe(2);
    expect(catalog.getState().snapshot.runs[0]?.run_id).toBe("b");
  });

  it("loading is true before the first poll and false after", async () => {
    const source = createMemorySource({
      listings: [[summary({ run_id: "a" })]],
    });
    const clock = manualScheduler();
    const catalog = createRunCatalog({
      source,
      scheduler: clock.scheduler,
    });

    expect(catalog.getState().loading).toBe(true);
    await catalog.start();
    expect(catalog.getState().loading).toBe(false);
  });
});
