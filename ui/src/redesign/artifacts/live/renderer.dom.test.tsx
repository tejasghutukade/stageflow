// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_LIBRARY_NAME, LIVE_LIBRARY_VERSION, LIVE_OPENUI_FORMAT, type ArtifactSnapshot } from "../../../api/artifacts";
import { LiveArtifactRenderer } from "./LiveArtifactRenderer";
import { resetLiveQueryCacheForTests } from "./toolProvider";
import type { LivePreviewInput } from "../livePreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { queryArtifactBinding } = vi.hoisted(() => ({ queryArtifactBinding: vi.fn() }));

vi.mock("../../../api/artifacts", async () => {
  const actual = await vi.importActual<typeof import("../../../api/artifacts")>("../../../api/artifacts");
  return { ...actual, queryArtifactBinding };
});

const snapshot = (value: unknown, fetchedAt: string): ArtifactSnapshot => ({
  binding_id: "rows",
  args_hash: "h",
  value,
  fetched_at: fetchedAt,
  duration_ms: 1,
  status: "ok",
  error_code: null,
});

const usageProgram = [
  'data = Query("get_usage", {range: "7"}, {total: "", rows: []})',
  'stat = Stat("Revenue", data.total, "ok")',
  'pill = StatusPill("ok", data.total)',
  'day = Col("Day", data.rows.day)',
  "table = Table([day])",
  'series = Series("Events", data.rows.events)',
  'chart = LineChart(data.rows.day, [series])',
  "root = Stack([stat, pill, table, chart])",
].join("\n");

const rangedProgram = [
  '$range = "7"',
  'opt7 = SelectItem("7", "7 days")',
  'opt30 = SelectItem("30", "30 days")',
  'picker = Select("range", [opt7, opt30], "Range", null, $range)',
  'data = Query("get_usage", {range: $range}, {rows: []})',
  "rows = data.rows",
  'day = Col("Day", rows.day)',
  "table = Table([day])",
  'series = Series("Events", rows.events)',
  "chart = LineChart(rows.day, [series])",
  "root = Stack([picker, table, chart])",
].join("\n");

const filterProgram = [
  '$range = "7"',
  'opt7 = SelectItem("7", "Seven")',
  'opt30 = SelectItem("30", "Thirty")',
  'picker = Select("range", [opt7, opt30], "Range", null, $range)',
  'data = Query("get_usage", {range: $range}, {rows: []})',
  "rows = data.rows",
  'day = Col("Day", rows.day)',
  "table = Table([day])",
  "root = Stack([picker, table])",
].join("\n");

function preview(patch: Partial<LivePreviewInput> = {}): LivePreviewInput {
  return {
    format: LIVE_OPENUI_FORMAT,
    library: { name: LIVE_LIBRARY_NAME, version: LIVE_LIBRARY_VERSION },
    program: usageProgram,
    bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
    snapshots: [],
    status: "fresh",
    lastRefreshedAt: "2026-11-24T13:00:00.000Z",
    lastErrorCode: null,
    settled: true,
    refreshing: false,
    historical: false,
    ownerKey: "stage:sales:summarize",
    artifactId: "weekly",
    ...patch,
  };
}

function queryResult(value: unknown) {
  return {
    status: 200,
    body: {
      binding_id: "rows",
      args_hash: "v",
      snapshot: snapshot(value, "2026-11-24T13:05:00.000Z"),
      errors: [],
    },
  };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  process.env.DO_NOT_TRACK = "1";
  resetLiveQueryCacheForTests();
  queryArtifactBinding.mockReset();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: () => ({ width: 8 }),
    fillText() {},
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    clearRect() {},
    setTransform() {},
    scale() {},
    rect() {},
    clip() {},
    arc() {},
    fillRect() {},
    strokeRect() {},
    translate() {},
    rotate() {},
    transform() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    canvas: document.createElement("canvas"),
  })) as unknown as HTMLCanvasElement["getContext"];
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mount(node: ReactNode) {
  const host = document.createElement("div");
  host.style.width = "280px";
  host.style.maxWidth = "280px";
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const render = (next: ReactNode) => {
    act(() => {
      root.render(next);
    });
  };
  render(node);
  return {
    host,
    render,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitForText(host: HTMLElement, needle: string) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (host.textContent?.includes(needle)) return;
    await settle();
  }
  expect(host.textContent ?? "").toContain(needle);
}

function assertNoActiveContent(root: ParentNode) {
  expect(root.querySelector("a, img, script, iframe")).toBeNull();
  for (const element of root.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      expect(name.toLowerCase().startsWith("on"), name).toBe(false);
      expect(name === "href" || name === "src", `${name} on ${element.tagName}`).toBe(false);
    }
  }
}

async function openAndChoose(label: string) {
  const trigger = document.querySelector<HTMLElement>("[role='combobox']");
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    trigger?.click();
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((element) => element.textContent?.includes(label));
  expect(option, document.body.textContent ?? "").toBeTruthy();
  await act(async () => {
    option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    option?.click();
  });
  await settle();
  await settle();
}

describe("live renderer DOM", () => {
  it("shows a skeleton until the first snapshot, then the chart, table, and stat", async () => {
    const seen: string[] = [];
    const view = mount(createNode(preview({ settled: false, refreshing: true, snapshots: [] })));
    await settle();
    expect(view.host.querySelector("[data-sf-state='Loading']")).toBeTruthy();
    expect(view.host.textContent).not.toContain("No data");
    seen.push(view.host.innerHTML);
    view.render(createNode(preview({
      settled: true,
      refreshing: false,
      snapshots: [snapshot({ total: "12", rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "12");
    await waitForText(view.host, "Mon");
    expect(view.host.querySelector("[data-sf-component='Stat']")?.textContent).toContain("12");
    expect(view.host.querySelector("[data-sf-component='Table']")?.textContent).toContain("Mon");
    expect(view.host.querySelector("[data-sf-component='LineChart']")).toBeTruthy();
    expect(seen.join("")).not.toContain("No data");
    expect(view.host.textContent).not.toContain("No data");
    view.render(createNode(preview({
      settled: true,
      snapshots: [snapshot({ total: "99", rows: [{ day: "Tue", events: 8 }] }, "2026-11-24T14:00:00.000Z")],
    })));
    await waitForText(view.host, "99");
    await waitForText(view.host, "Tue");
    await view.unmount();
  });

  it("keeps a select value when a variant result arrives and does not repeat the request", async () => {
    queryArtifactBinding.mockImplementation(async (_owner: string, _id: string, body: { args: { range?: string } }) => {
      const day = body.args.range === "30" ? "ThirtyDay" : "SevenDay";
      return queryResult({ rows: [{ day }] });
    });
    const view = mount(createNode(preview({
      program: filterProgram,
      snapshots: [snapshot({ rows: [{ day: "SevenDay" }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "SevenDay");
    const before = view.host.querySelector("[data-snapshot-key]")?.getAttribute("data-snapshot-key");
    await openAndChoose("Thirty");
    await waitForText(document.body, "ThirtyDay");
    expect(queryArtifactBinding).toHaveBeenCalledTimes(1);
    const call = queryArtifactBinding.mock.calls[0] as unknown as [string, string, { binding_id: string; args: Record<string, unknown> }];
    expect(call?.[2]).toMatchObject({ binding_id: "rows", args: { range: "30" } });
    expect(document.body.textContent).toContain("Thirty");
    expect(view.host.querySelector("[data-snapshot-key]")?.getAttribute("data-snapshot-key")).toBe(before);
    await openAndChoose("Seven");
    await waitForText(document.body, "SevenDay");
    await openAndChoose("Thirty");
    await waitForText(document.body, "ThirtyDay");
    expect(queryArtifactBinding).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("shows stale, empty, mismatch, and historical states", async () => {
    const stale = mount(createNode(preview({
      status: "stale",
      lastErrorCode: "artifact.resource_limit",
      program: 'root = TextContent("kept")',
      bindings: [],
      snapshots: [],
    })));
    expect(stale.host.textContent).toContain("Stale");
    expect(stale.host.textContent).toContain("The server is busy, will retry");
    expect(stale.host.textContent).toContain("kept");
    expect(stale.host.textContent).not.toContain("2026-11-24T13:00:00.000Z");
    await stale.unmount();

    const empty = mount(createNode(preview({
      program: 'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent("plain")',
      snapshots: [snapshot({ rows: [] }, "t")],
    })));
    expect(empty.host.textContent).toContain("No data");
    expect(empty.host.textContent).not.toContain("plain");
    await empty.unmount();

    const mismatch = mount(createNode(preview({
      program: 'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.missing)',
      snapshots: [snapshot({ rows: [{ day: "Mon" }] }, "t")],
    })));
    expect(mismatch.host.textContent).toContain("Data mismatch");
    await mismatch.unmount();

    const version = mount(createNode(preview({
      historical: true,
      snapshots: [],
      program: 'data = Query("get_usage", {}, {rows: []})\nroot = TextContent("old program")',
    })));
    expect(version.host.textContent).toContain("No data for this version");
    expect(version.host.textContent).toContain("old program");
    await version.unmount();

    const staticVersion = mount(createNode(preview({
      historical: true,
      snapshots: [],
      bindings: [],
      program: 'root = TextContent("static copy")',
    })));
    expect(staticVersion.host.textContent).toContain("static copy");
    expect(staticVersion.host.textContent).not.toContain("No data for this version");
    await staticVersion.unmount();
  });

  it("renders hostile strings as text inside the container", async () => {
    const hostile = `${"<img src=x onerror=alert(1)>"} ${"javascript:alert(1)"}`;
    const program = [
      `copy = TextContent(${JSON.stringify(hostile)})`,
      `note = Callout("error", ${JSON.stringify(hostile)}, ${JSON.stringify(hostile)})`,
      `tag = Tag(${JSON.stringify(hostile)})`,
      `stat = Stat(${JSON.stringify(hostile)}, ${JSON.stringify(hostile)})`,
      `pill = StatusPill("fail", ${JSON.stringify(hostile)})`,
      `opt = SelectItem("x", ${JSON.stringify(hostile)})`,
      'picker = Select("tone", [opt], "Pick")',
      "root = Stack([copy, note, tag, stat, pill, picker])",
    ].join("\n");
    const view = mount(createNode(preview({
      program,
      bindings: [],
      snapshots: [],
    })));
    await waitForText(view.host, "onerror");
    assertNoActiveContent(view.host);
    const box = view.host.querySelector<HTMLElement>(".sf-live-artifact");
    expect(box).toBeTruthy();
    if (box && box.clientWidth > 0) expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    const wall = "W".repeat(5000);
    const wide = mount(createNode(preview({
      program: `root = TextContent(${JSON.stringify(wall)})`,
      bindings: [],
      snapshots: [],
    })));
    await waitForText(wide.host, "WWW");
    const live = wide.host.querySelector<HTMLElement>(".sf-live-artifact");
    expect(live).toBeTruthy();
    const text = wide.host.querySelector<HTMLElement>("[data-sf-component='TextContent']");
    expect(text?.style.overflowWrap).toBe("anywhere");
    expect(text?.style.wordBreak).toBe("break-word");
    expect(text?.style.minWidth).toBe("0");
    expect(text?.style.maxWidth).toBe("100%");
    expect(live!.scrollWidth).toBeLessThanOrEqual(live!.clientWidth);
    assertNoActiveContent(wide.host);
    await view.unmount();
    await wide.unmount();
  });

  it("renders a mixed stack of stat, status, table, and line chart", async () => {
    const program = [
      'stat = Stat("Revenue", "12", "ok")',
      'pill = StatusPill("running", "Live")',
      'day = Col("Day", ["Mon"])',
      'count = Col("Count", [3])',
      "table = Table([day, count])",
      'series = Series("events", [3])',
      'chart = LineChart(["Mon"], [series])',
      "root = Stack([stat, pill, table, chart])",
    ].join("\n");
    const view = mount(createNode(preview({ program, bindings: [], snapshots: [] })));
    await waitForText(view.host, "Revenue");
    expect(view.host.querySelector("[data-sf-component='Stat']")).toBeTruthy();
    expect(view.host.querySelector("[data-sf-component='StatusPill']")).toBeTruthy();
    expect(view.host.querySelector("[data-sf-component='Table']")).toBeTruthy();
    expect(view.host.querySelector("[data-sf-component='LineChart']")).toBeTruthy();
    expect(view.host.textContent).toContain("Live");
    expect(view.host.textContent).toContain("Mon");
    await view.unmount();
  });

  it("does not remount when an auto refresh repeats the same value", async () => {
    queryArtifactBinding.mockImplementation(async (_owner: string, _id: string, body: { args: { range?: string } }) => {
      const day = body.args.range === "30" ? "ThirtyDay" : "SevenDay";
      return queryResult({ rows: [{ day, events: 4 }] });
    });
    const value = { rows: [{ day: "Mon", events: 3 }] };
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot(value, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    const node = view.host.querySelector("[data-renderer]");
    const key = node?.getAttribute("data-snapshot-key");
    const calls = queryArtifactBinding.mock.calls.length;
    expect(calls).toBe(1);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      view.render(createNode(preview({
        program: rangedProgram,
        refreshing: true,
        snapshots: [snapshot(value, "2026-11-24T13:00:00.000Z")],
      })));
      view.render(createNode(preview({
        program: rangedProgram,
        refreshing: false,
        snapshots: [snapshot(value, "2026-11-24T13:00:28.000Z")],
      })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(view.host.querySelector("[data-renderer]")).toBe(node);
      expect(view.host.querySelector("[data-renderer]")?.getAttribute("data-snapshot-key")).toBe(key);
      expect(queryArtifactBinding).toHaveBeenCalledTimes(calls);
      expect(document.querySelector("[role='combobox']")?.textContent).toContain("30");
      expect(view.host.textContent).toContain("ThirtyDay");
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  it("keeps a non-default filter when default data changes and shows new default data otherwise", async () => {
    queryArtifactBinding.mockImplementation(async (_owner: string, _id: string, body: { args: { range?: string } }) => {
      const day = body.args.range === "30" ? "ThirtyDay" : "SevenDay";
      return queryResult({ rows: [{ day, events: 9 }] });
    });
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    const before = queryArtifactBinding.mock.calls.filter((call) => {
      const body = call[2] as { args?: { range?: string } };
      return body.args?.range === "30";
    }).length;
    view.render(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Tue", events: 8 }] }, "2026-11-24T13:00:30.000Z")],
    })));
    await waitForText(view.host, "ThirtyDay");
    expect(view.host.textContent).not.toContain("Tue");
    expect(document.querySelector("[role='combobox']")?.textContent).toContain("30");
    expect(view.host.querySelector("[data-sf-component='LineChart']")?.getAttribute("data-sf-state")).not.toBe("no-data");
    const after = queryArtifactBinding.mock.calls.filter((call) => {
      const body = call[2] as { args?: { range?: string } };
      return body.args?.range === "30";
    }).length;
    expect(after - before).toBeLessThanOrEqual(1);
    expect(after).toBeGreaterThanOrEqual(1);
    await view.unmount();

    queryArtifactBinding.mockClear();
    const defaults = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(defaults.host, "Mon");
    defaults.render(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Tue", events: 8 }] }, "2026-11-24T13:00:30.000Z")],
    })));
    await waitForText(defaults.host, "Tue");
    expect(queryArtifactBinding).not.toHaveBeenCalled();
    expect(document.querySelector("[role='combobox']")?.textContent).toContain("7");
    await defaults.unmount();
  });

  it("resets filter state when the program text changes", async () => {
    queryArtifactBinding.mockImplementation(async () => queryResult({ rows: [{ day: "ThirtyDay", events: 9 }] }));
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    const revised = rangedProgram.replace('Select("range"', 'Select("window"');
    view.render(createNode(preview({
      program: revised,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    expect(view.host.textContent).not.toContain("ThirtyDay");
    expect(document.querySelector("[role='combobox']")?.textContent ?? "").not.toContain("30");
    expect(document.querySelector("[role='combobox']")?.textContent).toContain("7");
    await view.unmount();
  });

  it("falls back when a preserved option is removed", async () => {
    queryArtifactBinding.mockImplementation(async () => queryResult({ rows: [{ day: "ThirtyDay", events: 9 }] }));
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    const trimmed = rangedProgram.replace('opt30 = SelectItem("30", "30 days")\n', "").replace("[opt7, opt30]", "[opt7]");
    view.render(createNode(preview({
      program: trimmed,
      snapshots: [snapshot({ rows: [{ day: "Mon", events: 3 }] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    expect(view.host.textContent).not.toContain("ThirtyDay");
    expect(document.querySelector("[role='combobox']")?.textContent ?? "").not.toContain("30");
    expect(document.querySelector("[role='combobox']")?.textContent).toContain("7");
    expect(view.host.textContent).not.toContain("Parser crashed");
    await view.unmount();
  });

  it("hides the empty banner when the selected filter has rows", async () => {
    queryArtifactBinding.mockImplementation(async () => queryResult({ rows: [{ day: "ThirtyDay", events: 4 }] }));
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot({ rows: [] }, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "No data");
    expect(view.host.querySelector("[data-sf-state='No data']")?.textContent).toContain("The bound result has no rows.");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    await waitForText(view.host, "Showing filtered data");
    expect(view.host.querySelector("[data-sf-state='No data']")).toBeNull();
    expect(view.host.querySelector("[data-sf-component='LineChart']")?.getAttribute("data-sf-state")).not.toBe("no-data");
    await view.unmount();
  });

  it("drops the variant cache when a refresh starts", async () => {
    queryArtifactBinding.mockImplementation(async () => queryResult({ rows: [{ day: "ThirtyDay", events: 4 }] }));
    const value = { rows: [{ day: "Mon", events: 3 }] };
    const view = mount(createNode(preview({
      program: rangedProgram,
      snapshots: [snapshot(value, "2026-11-24T13:00:00.000Z")],
    })));
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    expect(queryArtifactBinding).toHaveBeenCalledTimes(1);
    view.render(createNode(preview({
      program: rangedProgram,
      refreshing: true,
      snapshots: [snapshot(value, "2026-11-24T13:00:00.000Z")],
    })));
    await settle();
    view.render(createNode(preview({
      program: rangedProgram,
      refreshing: false,
      snapshots: [snapshot(value, "2026-11-24T13:00:05.000Z")],
    })));
    await settle();
    expect(queryArtifactBinding).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role='combobox']")?.textContent).toContain("30");
    await openAndChoose("7 days");
    await waitForText(view.host, "Mon");
    await openAndChoose("30 days");
    await waitForText(view.host, "ThirtyDay");
    expect(queryArtifactBinding).toHaveBeenCalledTimes(2);
    await view.unmount();
  });
});

function createNode(input: LivePreviewInput) {
  return <LiveArtifactRenderer {...input} />;
}
