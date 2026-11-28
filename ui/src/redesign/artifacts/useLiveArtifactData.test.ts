import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_TTL_SECONDS,
  LIVE_REFRESH_MIN_SECONDS,
  type ArtifactDataResponse,
  type ArtifactRecord,
} from "../../api/artifacts";
import { ArtifactDetailPage, ArtifactDetailView } from "./ArtifactDetailPage";
import { artifactDetailMeta } from "./artifactDetailModel";
import {
  autoRefreshNote,
  createLiveRefreshController,
  formatUpdatedAgo,
  type LiveRefreshClock,
  type LiveScheduleConfig,
  type LiveScheduleOutcome,
  type LiveScheduleRequest,
} from "./liveRefreshSchedule";
import {
  createLiveArtifactDataModel,
  interpretRefreshResponse,
  liveArtifactScheduleConfig,
  useLiveArtifactData,
  type LiveHttpBody,
} from "./useLiveArtifactData";

class FakeClock implements LiveRefreshClock {
  time = 1_000_000;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, delayMs: number): number {
    const id = this.next;
    this.next += 1;
    this.timers.push({ id, at: this.time + delayMs, fn });
    return id;
  }

  clearTimer(id: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id);
      const next = due[0];
      if (!next) {
        this.time = target;
        return;
      }
      this.timers = this.timers.filter((timer) => timer.id !== next.id);
      this.time = next.at;
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

function record(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key: "stage:sales:summarize/weekly",
    id: "weekly",
    title: "Weekly",
    description: null,
    tags: [],
    kind: "live.declarative",
    origin: "published",
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    source: { run_id: null, stage_id: null, attempt: null, session_id: null },
    version: 2,
    size_bytes: 4,
    content_type: "application/vnd.stageflow.openui",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T12:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "proj", registered: true },
    live: {
      status: "fresh",
      last_refreshed_at: "2026-11-24T12:00:00.000Z",
      last_error_code: null,
      refresh: { on_view: true, ttl_seconds: 300, auto_seconds: 60 },
    },
    ...patch,
  };
}

describe("live refresh schedule", () => {
  function harness(config: LiveScheduleConfig) {
    const clock = new FakeClock();
    const calls: Array<{ ifStale: boolean; signal: AbortSignal }> = [];
    let settle: ((outcome: LiveScheduleOutcome) => void) | undefined;
    const controller = createLiveRefreshController({
      clock,
      onChange: () => undefined,
      refresh: (request: LiveScheduleRequest) => {
        calls.push(request);
        return new Promise<LiveScheduleOutcome>((resolve) => {
          settle = resolve;
        });
      },
    });
    controller.mount(config);
    return {
      clock,
      calls,
      controller,
      settle(outcome: LiveScheduleOutcome) {
        const resolve = settle;
        settle = undefined;
        resolve?.(outcome);
      },
    };
  }

  const enabled = (patch: Partial<LiveScheduleConfig> = {}): LiveScheduleConfig => ({
    enabled: true,
    onView: true,
    autoSeconds: null,
    visible: true,
    lastRefreshedAt: null,
    ...patch,
  });

  it("refreshes once on mount when on view is enabled", () => {
    const run = harness(enabled());
    expect(run.calls.map((call) => call.ifStale)).toEqual([true]);
  });

  it("waits for the interval, pauses while hidden, and catches up when shown", async () => {
    const run = harness(enabled({ onView: false, autoSeconds: 30, visible: true, lastRefreshedAt: 1_000_000 }));
    expect(run.calls).toHaveLength(0);
    await run.clock.advance(29_999);
    expect(run.calls).toHaveLength(0);
    await run.clock.advance(1);
    expect(run.calls.map((call) => call.ifStale)).toEqual([true]);
    run.settle({ ok: true, resourceLimit: false, refreshedAt: run.clock.now() });
    await Promise.resolve();
    run.controller.setVisible(false);
    await run.clock.advance(120_000);
    expect(run.calls).toHaveLength(1);
    run.controller.setVisible(true);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.ifStale).toBe(true);
  });

  it("does not refresh immediately when a hidden tab becomes visible inside the interval", async () => {
    const run = harness(enabled({ onView: false, autoSeconds: 30, visible: false, lastRefreshedAt: 1_000_000 }));
    run.controller.setVisible(true);
    expect(run.calls).toHaveLength(0);
    await run.clock.advance(30_000);
    expect(run.calls).toHaveLength(1);
  });

  it("skips an interval tick while a refresh is in flight", async () => {
    const run = harness(enabled({ autoSeconds: 30 }));
    expect(run.calls).toHaveLength(1);
    await run.clock.advance(30_000);
    expect(run.calls).toHaveLength(1);
    run.settle({ ok: true, resourceLimit: false, refreshedAt: run.clock.now() });
    await Promise.resolve();
    await run.clock.advance(30_000);
    expect(run.calls).toHaveLength(2);
    expect(run.calls.every((call) => call.ifStale)).toBe(true);
  });

  it("backs off after resource_limit and lets a manual refresh bypass it", async () => {
    const run = harness(enabled({ autoSeconds: 60 }));
    expect(run.calls).toHaveLength(1);
    run.settle({ ok: true, resourceLimit: true, retryAfterSeconds: 30, refreshedAt: run.clock.now() });
    await Promise.resolve();
    await run.clock.advance(29_000);
    expect(run.calls).toHaveLength(1);
    run.controller.manual();
    expect(run.calls.map((call) => call.ifStale)).toEqual([true, false]);
  });

  it("aborts the in-flight request and does not schedule after unmount", async () => {
    const run = harness(enabled({ autoSeconds: 30 }));
    const signal = run.calls[0]?.signal;
    run.controller.unmount();
    expect(signal?.aborted).toBe(true);
    await run.clock.advance(120_000);
    expect(run.calls).toHaveLength(1);
  });

  it("does not refresh an older version, an expired artifact, or a hidden artifact", async () => {
    for (const config of [enabled({ enabled: false, onView: false, autoSeconds: 30 })]) {
      const run = harness(config);
      run.controller.manual();
      await run.clock.advance(120_000);
      expect(run.calls).toHaveLength(0);
    }
  });
});

describe("live artifact schedule config", () => {
  it("formats the age and the auto-refresh note", () => {
    expect(formatUpdatedAgo("2026-11-24T12:00:04.000Z", Date.parse("2026-11-24T12:00:09.000Z"))).toBe("Updated 5s ago");
    expect(formatUpdatedAgo(null, 0)).toBeNull();
    expect(DEFAULT_LIVE_TTL_SECONDS).toBe(300);
    expect(LIVE_REFRESH_MIN_SECONDS).toBe(30);
    expect(autoRefreshNote(60)).toBe("Checking every 60s · data refreshed at most every 300s");
    expect(autoRefreshNote(60, 30)).toBe("Checking every 60s · data refreshed at most every 30s");
    expect(autoRefreshNote(10)).toBeNull();
  });

  it("disables refresh for an older version, an expired artifact, a hidden artifact, and on_view false", () => {
    const current = record();
    expect(liveArtifactScheduleConfig(current, { ownerKey: "stage:sales:summarize", id: "weekly", latestVersion: 2 })).toMatchObject({
      enabled: true,
      onView: true,
      autoSeconds: 60,
    });
    expect(
      liveArtifactScheduleConfig(current, { ownerKey: "stage:sales:summarize", id: "weekly", version: 1, latestVersion: 2 }).enabled,
    ).toBe(false);
    expect(
      liveArtifactScheduleConfig(record({ version: 1 }), { ownerKey: "stage:sales:summarize", id: "weekly", version: 1, latestVersion: 2 }).enabled,
    ).toBe(false);
    expect(
      liveArtifactScheduleConfig(current, { ownerKey: "stage:sales:summarize", id: "weekly" }).enabled,
    ).toBe(false);
    expect(liveArtifactScheduleConfig(record({ status: "expired" }), { ownerKey: "k", id: "weekly", latestVersion: 2 }).enabled).toBe(false);
    expect(liveArtifactScheduleConfig(current, { ownerKey: "k", id: "weekly", hidden: true, latestVersion: 2 }).enabled).toBe(false);
    const manual = record({ live: { status: null, refresh: { on_view: false, auto_seconds: 45 } } });
    expect(liveArtifactScheduleConfig(manual, { ownerKey: "k", id: "weekly", latestVersion: 2 })).toMatchObject({
      enabled: true,
      onView: false,
      autoSeconds: 45,
    });
    expect(liveArtifactScheduleConfig(record({ kind: "static.markdown", live: undefined }), { ownerKey: "k", id: "weekly" }).enabled).toBe(
      false,
    );
  });

  it("server-renders the hook and the detail page", () => {
    function Probe() {
      const live = useLiveArtifactData(record(), { ownerKey: "stage:sales:summarize", id: "weekly" });
      return createElement("p", null, live.refreshing ? "busy" : "idle", live.lastError ?? "");
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain("idle");
    expect(
      renderToStaticMarkup(createElement(ArtifactDetailPage, { ownerKey: "stage:sales:summarize", id: "weekly" })),
    ).toContain("Loading artifact…");
  });
});

describe("stored snapshots on open", () => {
  const stored: ArtifactDataResponse = {
    status: "fresh",
    last_refreshed_at: "2026-11-24T12:00:00.000Z",
    last_error_code: null,
    errors: [],
    snapshots: [{
      binding_id: "rows",
      args_hash: "h",
      value: { weeks: 12 },
      fetched_at: "2026-11-24T12:00:00.000Z",
      duration_ms: 4,
      status: "ok",
      error_code: null,
    }],
  };
  const limited: ArtifactDataResponse = {
    status: "stale",
    last_refreshed_at: "2026-11-24T12:00:00.000Z",
    last_error_code: "artifact.resource_limit",
    errors: [{ binding_id: "rows", code: "artifact.resource_limit" }],
    retry_after_seconds: 30,
    snapshots: stored.snapshots,
  };
  const emptyLimit: ArtifactDataResponse = {
    status: "error",
    last_refreshed_at: null,
    last_error_code: "artifact.resource_limit",
    errors: [{ binding_id: "rows", code: "artifact.resource_limit" }],
    retry_after_seconds: 30,
    snapshots: [],
  };

  function open(options: {
    record?: ArtifactRecord;
    view?: { version?: number; hidden?: boolean; latestVersion?: number; omitLatest?: boolean };
    load?: LiveHttpBody;
    refreshBody?: LiveHttpBody;
  }) {
    const calls: string[] = [];
    let state: Omit<ReturnType<typeof useLiveArtifactData>, "refresh" | "settled"> | undefined;
    const subject = options.record ?? record();
    const { omitLatest, ...view } = options.view ?? {};
    const model = createLiveArtifactDataModel({
      record: subject,
      options: {
        ownerKey: "stage:sales:summarize",
        id: "weekly",
        ...view,
        ...(omitLatest ? {} : { latestVersion: view.latestVersion ?? subject.version }),
      },
      clock: new FakeClock(),
      loadStored: async () => {
        calls.push("load");
        return options.load ?? { status: 200, body: stored };
      },
      refresh: async () => {
        calls.push("refresh");
        return options.refreshBody ?? { status: 200, body: stored };
      },
      syncRecord: async () => {
        calls.push("sync");
      },
      onChange: (next) => {
        state = next;
      },
    });
    return {
      calls,
      model,
      read: () => state,
      async settle() {
        await model.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }

  it("shows stored snapshots when on_view is false and refreshes when it is allowed", async () => {
    const quiet = open({
      record: record({ live: { status: "fresh", last_refreshed_at: "2026-11-24T12:00:00.000Z", last_error_code: null, refresh: { on_view: false } } }),
    });
    await quiet.settle();
    expect(quiet.calls).toEqual(["load"]);
    expect(quiet.read()?.snapshots[0]?.value).toEqual({ weeks: 12 });
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(record()),
      preview: null,
      live: record().live,
      liveData: {
        status: quiet.read()?.status ?? null,
        snapshots: quiet.read()?.snapshots ?? [],
        last_refreshed_at: quiet.read()?.lastRefreshedAt ?? null,
        last_error_code: quiet.read()?.lastErrorCode ?? null,
        errors: quiet.read()?.errors ?? [],
      },
      onBack: () => undefined,
    }));
    expect(html).toContain("weeks");
    expect(html).toContain("rows");

    const follow = open({});
    await follow.settle();
    expect(follow.calls).toEqual(["load", "sync", "refresh"]);
  });

  it("marks expired data unavailable and does not refresh a hidden artifact", async () => {
    const expired = open({
      record: record({ status: "expired" }),
      load: { status: 404, body: { error: "This artifact has expired", code: "artifact.content_unavailable" } },
    });
    await expired.settle();
    expect(expired.calls).toEqual(["load"]);
    expect(expired.read()?.unavailable).toBe(true);
    expect(expired.read()?.unavailableMessage).toBe("This artifact has expired");
    expect(expired.read()?.snapshots).toEqual([]);
    expect(expired.read()?.lastError).toBeNull();

    const hidden = open({ view: { hidden: true } });
    await hidden.settle();
    expect(hidden.calls).toEqual(["load"]);
    expect(hidden.read()?.snapshots).toHaveLength(1);

    const older = open({ view: { version: 1, latestVersion: 2 } });
    await older.settle();
    expect(older.calls).toEqual([]);

    const historicalRecord = open({ record: record({ version: 1 }), view: { version: 1, latestVersion: 2 } });
    await historicalRecord.settle();
    expect(historicalRecord.calls).toEqual([]);

    const pending = open({ view: { omitLatest: true } });
    await pending.settle();
    expect(pending.calls).toEqual([]);
    const proceeded = open({ view: { latestVersion: 2 } });
    await proceeded.settle();
    expect(proceeded.calls).toEqual(["load", "sync", "refresh"]);

    const switched = open({ view: { version: 2, latestVersion: 2 } });
    await switched.settle();
    expect(switched.calls).toEqual(["load", "sync", "refresh"]);
  });

  it("keeps snapshots for a 200 resource limit and applies a 503 refresh body", async () => {
    expect(interpretRefreshResponse(200, limited).outcome).toMatchObject({ ok: true, resourceLimit: true, retryAfterSeconds: 30 });
    expect(interpretRefreshResponse(503, emptyLimit).data?.snapshots).toEqual([]);
    expect(interpretRefreshResponse(503, emptyLimit).outcome.resourceLimit).toBe(true);
    const bare = interpretRefreshResponse(429, { error: "Too many refreshes are waiting", code: "artifact.resource_limit" });
    expect(bare.data).toBeNull();
    expect(bare.outcome).toMatchObject({ ok: false, resourceLimit: true, error: "Too many refreshes are waiting" });

    const kept = open({ refreshBody: { status: 429, body: { error: "Too many refreshes are waiting", code: "artifact.resource_limit" } } });
    await kept.settle();
    expect(kept.read()?.snapshots[0]?.value).toEqual({ weeks: 12 });
    expect(kept.read()?.lastError).toBe("Too many refreshes are waiting");

    const empty = open({ refreshBody: { status: 503, body: emptyLimit } });
    await empty.settle();
    expect(empty.read()?.snapshots).toEqual([]);
    expect(empty.read()?.status).toBe("error");
    expect(empty.read()?.lastError).toBeNull();

    const stale = open({ refreshBody: { status: 200, body: limited } });
    await stale.settle();
    expect(stale.read()?.status).toBe("stale");
    expect(stale.read()?.snapshots[0]?.value).toEqual({ weeks: 12 });
    expect(stale.read()?.lastError).toBeNull();
  });

  it("re-reads the record on each refresh tick and when the tab becomes visible", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const subject = record({ kind: "live.html" });
    const model = createLiveArtifactDataModel({
      record: subject,
      options: { ownerKey: "stage:sales:summarize", id: "weekly", latestVersion: subject.version },
      clock,
      loadStored: async () => ({ status: 200, body: stored }),
      refresh: async () => {
        calls.push("refresh");
        return { status: 200, body: stored };
      },
      syncRecord: async () => {
        calls.push("sync");
      },
      onChange: () => undefined,
    });
    await model.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["sync", "refresh"]);
    calls.length = 0;
    await clock.advance(60_000);
    expect(calls).toEqual(["sync", "refresh"]);
    calls.length = 0;
    model.setVisible(false);
    expect(calls).toEqual([]);
    model.setVisible(true);
    await Promise.resolve();
    expect(calls).toEqual(["sync"]);
    model.unmount();
  });
});
