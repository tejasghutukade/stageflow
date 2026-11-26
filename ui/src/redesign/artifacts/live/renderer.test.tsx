import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LIVE_LIBRARY_NAME, LIVE_LIBRARY_VERSION, LIVE_OPENUI_FORMAT } from "../../../api/artifacts";
import { resetLiveActionWarningForTests, ignoreLiveArtifactAction } from "./actions";
import { assessLiveProgramData, liveDefaultSnapshotKey, liveDefaultValueCanon, sanitizeLiveViewerState } from "./dataState";
import { LiveArtifactRenderer } from "./LiveArtifactRenderer";
import { ProgramSource } from "./states";
import { liveVocabularyPropOrder, stageflowRenderLibrary } from "./library";
import { libraryPreviewMessage, liveLibraryVersionStatus } from "./libraryVersion";
import { LIVE_BAR_MAX_WIDTH } from "./charts";
import { Card } from "./layout";
import { Callout, SectionCard, Stat, StatusPill, Tag, TextContent } from "./plain";
import { CHART_COLORS, SF_OPENUI_TOKEN_MAP, chartPaletteForSeries } from "./theme";
import {
  canonicalJson,
  clearLiveQueryCache,
  createLiveToolProvider,
  LIVE_QUERY_CACHE_MAX,
  liveQueryCacheSizeForTests,
  resetLiveQueryCacheForTests,
} from "./toolProvider";
import type { LivePreviewInput } from "../livePreview";

const uiSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function distributed(colors: string[], dataLength: number): string[] {
  const n = colors.length;
  const mid = Math.floor(n / 2);
  const wrap = (index: number) => colors[(index % n + n) % n]!;
  if (dataLength === 1) return [colors[mid]!];
  if (dataLength === 2) return [colors[Math.max(mid - 1, 0)]!, colors[Math.min(mid + 1, n - 1)]!];
  const offset = Math.floor((dataLength - 1) / 2);
  return Array.from({ length: dataLength }, (_, index) => wrap(mid + (index - offset)));
}

const hostile = ["[x](javascript:alert(1))", "<img src=x onerror=alert(1)>", "https://example.com", "data:text/html;base64,abc"];

function markup(component: { component: unknown }, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(component.component as never, { props, renderNode: () => null }));
}

function preview(patch: Partial<LivePreviewInput> = {}): LivePreviewInput {
  return {
    format: LIVE_OPENUI_FORMAT,
    library: { name: LIVE_LIBRARY_NAME, version: LIVE_LIBRARY_VERSION },
    program: 'root = TextContent("hello")',
    bindings: [],
    snapshots: [],
    status: "fresh",
    lastRefreshedAt: "2026-11-24T13:00:00.000Z",
    lastErrorCode: null,
    settled: true,
    historical: false,
    ownerKey: "stage:sales:summarize",
    artifactId: "weekly",
    ...patch,
  };
}

describe("live renderer", () => {
  it("matches the Node vocabulary prop order", async () => {
    process.env.OPENUI_TELEMETRY_DISABLED = "1";
    process.env.DO_NOT_TRACK = "1";
    const source = await import("../../../../../src/artifacts/library/index.ts");
    const ui = liveVocabularyPropOrder();
    expect(ui.map((entry) => entry.name).sort()).toEqual([...source.VOCABULARY_NAMES].sort());
    for (const entry of source.VOCABULARY) {
      const match = ui.find((item) => item.name === entry.name);
      expect(match?.props).toEqual([...entry.props]);
    }
    expect(LIVE_LIBRARY_VERSION).toBe(source.LIBRARY_VERSION);
    expect(LIVE_LIBRARY_NAME).toBe(source.LIBRARY_NAME);
  });

  it("renders a mixed stack of custom and stock components", () => {
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
    const html = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({ program })));
    expect(html).toContain('data-sf-component="Stack"');
    expect(html).toContain('data-sf-component="Stat"');
    expect(html).toContain('data-sf-component="StatusPill"');
    expect(html).toContain('data-sf-component="Table"');
    expect(html).toContain('data-sf-component="LineChart"');
    expect(html).toContain("Revenue");
    expect(html).toContain("Live");
    expect(html).toContain("Mon");
  });

  it("renders strings as text", () => {
    for (const text of hostile) {
      for (const html of [
        markup(TextContent, { text }),
        markup(Callout, { variant: "info", title: text, description: text }),
        markup(Tag, { text }),
        markup(Stat, { label: text, value: text }),
        markup(SectionCard, { title: text, body: text }),
      ]) {
        expect(html.toLowerCase()).not.toContain("<a ");
        expect(html.toLowerCase()).not.toContain("<img");
        expect(html.toLowerCase()).not.toContain("<script");
      }
    }
  });

  it("maps default args to the snapshot and other args to the query route", async () => {
    const fetchMock = vi.fn(async (): Promise<{ status: number; json: () => Promise<unknown> }> => ({
      status: 200,
      json: async () => ({
        binding_id: "rows",
        args_hash: "h",
        snapshot: {
          binding_id: "rows",
          args_hash: "h",
          value: { rows: [{ day: "Tue" }] },
          fetched_at: "2026-11-24T13:00:00.000Z",
          duration_ms: 1,
          status: "ok",
          error_code: null,
        },
        errors: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createLiveToolProvider({
      bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      snapshots: [{
        binding_id: "rows",
        args_hash: "stored",
        value: { rows: [{ day: "Mon" }] },
        fetched_at: "2026-11-24T13:00:00.000Z",
        duration_ms: 1,
        status: "ok",
        error_code: null,
      }],
      query: async ({ bindingId, args }) => {
        const { queryArtifactBinding } = await import("../../../api/artifacts");
        return queryArtifactBinding("stage:sales:summarize", "weekly", { binding_id: bindingId, args });
      },
    });
    await expect(provider.get_usage!({ range: "7" })).resolves.toEqual({ rows: [{ day: "Mon" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(provider.get_usage!({ range: "30" })).resolves.toEqual({ rows: [{ day: "Tue" }] });
    const calls = fetchMock.mock.calls as unknown as unknown[][];
    expect(String(calls[0]?.[0])).toContain("/api/artifacts/stage%3Asales%3Asummarize/weekly/query");
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        binding_id: "rows",
        args_hash: "h",
        snapshot: {
          binding_id: "rows",
          args_hash: "h",
          value: null,
          fetched_at: "2026-11-24T13:00:00.000Z",
          duration_ms: 1,
          status: "error",
          error_code: "artifact.binding_failed",
        },
        errors: [{ binding_id: "rows", code: "artifact.binding_failed" }],
      }),
    });
    await expect(provider.get_usage!({ range: "1" })).rejects.toThrow("artifact.binding_failed");
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ error: "busy", code: "artifact.resource_limit", retry_after_seconds: 30 }) });
    await expect(provider.get_usage!({ range: "2" })).rejects.toThrow("artifact.resource_limit");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(provider.get_usage!({ range: "3" })).rejects.toThrow("offline");
    expect(canonicalJson({ b: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":1}');
    vi.unstubAllGlobals();
  });

  it("shows loading, error, stale, empty, mismatch, version, and format states", () => {
    expect(renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      settled: false,
      program: 'data = Query("get_usage", {}, {rows: []})\nroot = TextContent("x")',
      bindings: [{ id: "rows", function: "get_usage", args: {} }],
      snapshots: [],
    })))).toContain("Loading");
    expect(renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      status: "error",
      snapshots: [],
      lastErrorCode: "artifact.binding_failed",
    })))).toContain("artifact.binding_failed");
    const stale = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      status: "stale",
      lastErrorCode: "artifact.resource_limit",
      program: 'root = TextContent("kept")',
    })));
    expect(stale).toContain("Stale");
    expect(stale).toContain("The server is busy, will retry");
    expect(stale).toContain("artifact.resource_limit");
    expect(stale).not.toContain("2026-11-24T13:00:00.000Z");
    expect(stale).toContain("UTC");
    expect(stale).toContain("kept");
    const empty = assessLiveProgramData(
      'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.day)',
      [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      [{ binding_id: "rows", args_hash: "h", value: { rows: [] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    );
    expect(empty.state).toBe("empty");
    expect(renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      program: 'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.day)',
      bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      snapshots: [{ binding_id: "rows", args_hash: "h", value: { rows: [] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    })))).toContain("No data");
    const mismatch = assessLiveProgramData(
      'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.missing)',
      [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      [{ binding_id: "rows", args_hash: "h", value: { rows: [{ day: "Mon" }] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    );
    expect(mismatch.state).toBe("mismatch");
    expect(renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      program: 'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.missing)',
      bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      snapshots: [{ binding_id: "rows", args_hash: "h", value: { rows: [{ day: "Mon" }] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    })))).toContain("Data mismatch");
    expect(liveLibraryVersionStatus({ name: "stageflow", version: "0.9.0" })).toBe("older");
    expect(liveLibraryVersionStatus({ name: "other", version: "1.0.0" })).toBe("unknown");
    const older = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      library: { name: "stageflow", version: "0.9.0" },
    })));
    expect(older).toContain(libraryPreviewMessage({ name: "stageflow", version: "0.9.0" }));
    expect(older).not.toContain('data-sf-component="TextContent"');
    const unknown = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({ format: "stageflow-json" })));
    expect(unknown).toContain("Cannot preview this format");
    const hiddenProgram = "root = TextContent(\"kept source\")";
    const formatCard = renderToStaticMarkup(createElement("div", null,
      createElement(LiveArtifactRenderer, preview({ format: "json-render", program: hiddenProgram })),
      createElement(ProgramSource, { program: hiddenProgram }),
    ));
    expect(formatCard).toContain("Cannot preview this format");
    expect(formatCard).toContain("json-render");
    expect(formatCard).toContain("<details");
    expect(formatCard).not.toContain("<details open");
    expect(formatCard).toContain("kept source");
    expect(formatCard).not.toContain('data-sf-component="TextContent"');
    const historical = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      historical: true,
      snapshots: [],
      program: 'data = Query("get_usage", {}, {rows: []})\nroot = TextContent("version text")',
      bindings: [{ id: "rows", function: "get_usage", args: {} }],
    })));
    expect(historical).toContain("No data for this version");
    expect(historical).toContain("version text");
    const historicalStatic = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      historical: true,
      snapshots: [],
      program: 'root = TextContent("static copy")',
    })));
    expect(historicalStatic).toContain("static copy");
    expect(historicalStatic).not.toContain("No data for this version");
    const latest = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      historical: true,
      snapshots: [{ binding_id: "rows", args_hash: "h", value: { rows: [] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    })));
    expect(latest).toContain("Snapshots are for the current version: data shown is the latest");
  });

  it("keeps the skeleton until a default snapshot exists and banners filters", () => {
    const queried = 'data = Query("get_usage", {range: "7"}, {rows: []})\nrows = data.rows\nroot = TextContent(rows.day)';
    const bindings = [{ id: "rows", function: "get_usage", args: { range: "7" } }];
    const loading = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      settled: true,
      refreshing: true,
      program: queried,
      bindings,
      snapshots: [],
    })));
    expect(loading).toContain("Loading");
    expect(loading).not.toContain("No data");
    expect(loading).not.toContain('data-renderer="stageflow-live-renderer"');
    const withSelect = [
      '$range = "7"',
      'data = Query("get_usage", {range: $range}, {rows: []})',
      "rows = data.rows",
      'picker = Select("range", [SelectItem("7", "7 days"), SelectItem("30", "30 days")], "Range", null, $range)',
      "root = Stack([picker, TextContent(rows.day)])",
    ].join("\n");
    const empty = [{ binding_id: "rows", args_hash: "h", value: { rows: [] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }];
    const banner = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      program: withSelect,
      bindings,
      snapshots: empty,
    })));
    expect(banner).toContain("No data");
    expect(banner).toContain("Range");
    const mismatch = renderToStaticMarkup(createElement(LiveArtifactRenderer, preview({
      program: withSelect.replace("rows.day", "rows.missing"),
      bindings,
      snapshots: [{ binding_id: "rows", args_hash: "h", value: { rows: [{ day: "Mon" }] }, fetched_at: "t", duration_ms: 1, status: "ok", error_code: null }],
    })));
    expect(mismatch).toContain("Data mismatch");
    expect(mismatch).toContain("Range");
  });

  it("sizes text, maps an error callout, and wraps labels", () => {
    const heavy = markup(TextContent, { text: "48", size: "large-heavy" });
    expect(heavy).toContain("28px");
    expect(heavy).toContain("600");
    expect(markup(TextContent, { text: "48", size: "large" })).toContain("20px");
    const callout = markup(Callout, { variant: "error", title: "Down", description: "failed" });
    expect(callout).toContain("openui-callout-danger");
    expect(callout).not.toContain("openui-callout-warning");
    const warning = markup(Callout, { variant: "warning", title: "Slow", description: "wait" });
    expect(warning).toContain("openui-callout-warning");
    const card = markup(Card, { children: [] });
    expect(card).toContain("var(--sf-panel)");
    expect(card).toContain("var(--sf-hairline)");
    expect(markup(Tag, { text: "Live" })).toContain("fit-content");
    expect(markup(StatusPill, { tone: "ok", label: "Live" })).toContain("fit-content");
    expect(markup(Stat, { label: "A", value: "1" })).toContain("overflow-wrap:anywhere");
    expect(LIVE_BAR_MAX_WIDTH).toBeGreaterThan(16);
  });

  it("dedupes a repeated variant query", async () => {
    resetLiveQueryCacheForTests();
    let calls = 0;
    const provider = createLiveToolProvider({
      bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      snapshots: [],
      cacheScope: "dedupe",
      query: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: 200,
          body: {
            binding_id: "rows",
            args_hash: "h",
            snapshot: {
              binding_id: "rows",
              args_hash: "h",
              value: { rows: [{ day: "Tue" }] },
              fetched_at: "t",
              duration_ms: 1,
              status: "ok",
              error_code: null,
            },
            errors: [],
          },
        };
      },
    });
    const [first, second] = await Promise.all([
      provider.get_usage!({ range: "30" }),
      provider.get_usage!({ range: "30" }),
    ]);
    expect(first).toEqual({ rows: [{ day: "Tue" }] });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    await provider.get_usage!({ range: "30" });
    expect(calls).toBe(1);
    clearLiveQueryCache();
    await provider.get_usage!({ range: "30" });
    expect(calls).toBe(2);
    resetLiveQueryCacheForTests();
  });

  it("drops the oldest variant result past 64 entries", async () => {
    resetLiveQueryCacheForTests();
    let calls = 0;
    const provider = createLiveToolProvider({
      bindings: [{ id: "rows", function: "get_usage", args: { range: "7" } }],
      snapshots: [],
      cacheScope: "cap",
      query: async ({ args }) => {
        calls += 1;
        return {
          status: 200,
          body: {
            binding_id: "rows",
            args_hash: "h",
            snapshot: {
              binding_id: "rows",
              args_hash: "h",
              value: { rows: [{ day: String(args.range) }] },
              fetched_at: "t",
              duration_ms: 1,
              status: "ok",
              error_code: null,
            },
            errors: [],
          },
        };
      },
    });
    for (let index = 0; index < LIVE_QUERY_CACHE_MAX + 1; index += 1) {
      await provider.get_usage!({ range: `v${index}` });
    }
    expect(calls).toBe(LIVE_QUERY_CACHE_MAX + 1);
    expect(liveQueryCacheSizeForTests()).toBe(LIVE_QUERY_CACHE_MAX);
    await provider.get_usage!({ range: "v0" });
    expect(calls).toBe(LIVE_QUERY_CACHE_MAX + 2);
    await provider.get_usage!({ range: `v${LIVE_QUERY_CACHE_MAX}` });
    expect(calls).toBe(LIVE_QUERY_CACHE_MAX + 2);
    resetLiveQueryCacheForTests();
  });

  it("keeps a snapshot key on the value and drops a stale filter value", () => {
    const bindings = [{ id: "rows", function: "get_usage", args: { range: "7" } }];
    const value = { rows: [{ day: "Mon" }] };
    const first = [{ binding_id: "rows", args_hash: "h", value, fetched_at: "t1", duration_ms: 1, status: "ok" as const, error_code: null }];
    const same = [{ ...first[0]!, fetched_at: "t2", args_hash: "other" }];
    const changed = [{ ...first[0]!, value: { rows: [{ day: "Tue" }] }, fetched_at: "t2" }];
    expect(liveDefaultValueCanon(bindings, first)).toBe(liveDefaultValueCanon(bindings, same));
    expect(liveDefaultSnapshotKey(bindings, first)).toBe(liveDefaultSnapshotKey(bindings, same));
    expect(liveDefaultSnapshotKey(bindings, first)).not.toBe(liveDefaultSnapshotKey(bindings, changed));
    const program = [
      '$range = "7"',
      'opt7 = SelectItem("7", "7 days")',
      'picker = Select("range", [opt7], "Range", null, $range)',
      "root = TextContent($range)",
    ].join("\n");
    expect(sanitizeLiveViewerState({ $range: "30", $gone: "x", other: { value: "30" } }, program)).toBeUndefined();
    expect(sanitizeLiveViewerState({ $range: "7", $gone: "x" }, program)).toEqual({ $range: "7" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(sanitizeLiveViewerState({ $range: cycle }, program)).toBeUndefined();
  });

  it("warns once for actions and never opens a url", () => {
    resetLiveActionWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ignoreLiveArtifactAction({ type: "OpenUrl" });
    ignoreLiveArtifactAction({ type: "OpenUrl" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(new URL("./actions.ts", import.meta.url), "utf8")).not.toMatch(/window\.open|location\.href/);
    warn.mockRestore();
  });

  it("maps every theme token onto a console variable", () => {
    const tokens = readFileSync(path.resolve(uiSrc, "redesign/tokens.css"), "utf8");
    for (const value of Object.values(SF_OPENUI_TOKEN_MAP)) {
      const name = /var\((--sf-[a-z0-9-]+)\)/.exec(value)?.[1];
      expect(name, value).toBeTruthy();
      expect(tokens).toContain(`${name}:`);
    }
    for (const color of CHART_COLORS) {
      const name = /var\((--sf-[a-z0-9-]+)\)/.exec(color)?.[1];
      expect(tokens).toContain(`${name}:`);
    }
    for (const count of [1, 2, 3, 4, 5]) {
      expect(distributed(chartPaletteForSeries(count), count)[0]).toBe(CHART_COLORS[0]);
    }
  });

  it("matches component JSON schemas except descriptions", async () => {
    process.env.OPENUI_TELEMETRY_DISABLED = "1";
    process.env.DO_NOT_TRACK = "1";
    const source = await import("../../../../../src/artifacts/library/index.ts");
    const nodeSchema = source.libraryJsonSchema();
    const uiSchema = stageflowRenderLibrary.toJSONSchema();
    const differences = schemaDifferences(nodeSchema, uiSchema);
    expect(differences, differences.join("\n")).toEqual([]);
  });

  it("keeps OpenUI imports inside the live renderer", () => {
    const root = path.resolve(uiSrc);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
        const relative = path.relative(root, full);
        if (relative.startsWith(`redesign/artifacts/live${path.sep}`) || relative.startsWith("redesign/artifacts/live/")) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("@openuidev/") || text.includes("@sf-openui")) offenders.push(relative);
        const page =
          relative.endsWith(`redesign${path.sep}artifacts${path.sep}ArtifactView.tsx`) ||
          relative.endsWith("redesign/artifacts/ArtifactView.tsx");
        for (const ref of liveModuleRefs(text)) {
          if (page && ref.includes('import("./live/LiveArtifactRenderer")')) continue;
          offenders.push(`${relative} ${ref}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    const page = readFileSync(path.resolve(root, "redesign/artifacts/ArtifactView.tsx"), "utf8");
    expect(page).toContain('import("./live/LiveArtifactRenderer")');
    const beside = 'import { LiveArtifactRenderer } from "./live/LiveArtifactRenderer";\nconst lazy = import("./live/LiveArtifactRenderer");\n';
    expect(liveModuleRefs(beside).some((ref) => ref.includes("import { LiveArtifactRenderer }"))).toBe(true);
    expect(liveModuleRefs('import type { Marker } from "./live/types";\nconst lazy = import("./live/LiveArtifactRenderer");\n')).toEqual([]);
    expect(liveModuleRefs('import type { Marker } from "./live/library";\n')).not.toEqual([]);
  });
});

function isLiveSpecifier(spec: string): boolean {
  return spec.includes("/live/") || spec.startsWith("./live/") || spec.startsWith("live/");
}

export function liveModuleRefs(source: string): string[] {
  const found: string[] = [];
  const fromRe = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\sfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(source))) {
    const spec = match[3] ?? "";
    if (!isLiveSpecifier(spec)) continue;
    const clause = match[2] ?? "";
    const typeOnly = /^\s*type\b/.test(clause);
    const typesFile = /(?:^|\/)live\/types(?:\.ts)?$/.test(spec);
    if (match[1] === "import" && typeOnly && typesFile) continue;
    found.push(match[0].trim());
  }
  const dynamicRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicRe.exec(source))) {
    const spec = match[1] ?? "";
    if (!isLiveSpecifier(spec)) continue;
    if (spec.endsWith("./live/LiveArtifactRenderer") || spec.endsWith("/live/LiveArtifactRenderer")) continue;
    found.push(match[0]);
  }
  return found;
}

type PropSig = { kind: string; enum?: string[]; required: boolean };

function isNullSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as { type?: unknown };
  return node.type === "null" || (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === "null");
}

function resolveRef(schema: unknown, defs: Record<string, unknown>): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return schema;
  return defs[ref.slice("#/$defs/".length)] ?? schema;
}

function propKind(schema: unknown, defs: Record<string, unknown> = {}): { kind: string; enum?: string[] } {
  schema = resolveRef(schema, defs);
  if (!schema || typeof schema !== "object") return { kind: "any" };
  const node = schema as { anyOf?: unknown[]; type?: unknown; enum?: unknown[]; properties?: unknown; $ref?: unknown };
  if (Array.isArray(node.anyOf)) {
    const parts = node.anyOf.filter((part) => !isNullSchema(part));
    if (parts.length === 0) return { kind: "null" };
    if (parts.length === 1) return propKind(parts[0], defs);
    const kinds = parts.map((part) => propKind(part, defs).kind);
    if (kinds.every((kind) => kind === "any")) return { kind: "any" };
    return { kind: "union" };
  }
  if (Array.isArray(node.type)) {
    const types = node.type.filter((item) => item !== "null");
    if (types.length === 1) return propKind({ ...node, type: types[0] }, defs);
    return { kind: "union" };
  }
  if (Array.isArray(node.enum)) return { kind: "enum", enum: node.enum.map(String).sort() };
  if (node.type === "array") return { kind: "array" };
  if (node.type === "string") return { kind: "string" };
  if (node.type === "number" || node.type === "integer") return { kind: "number" };
  if (node.type === "boolean") return { kind: "boolean" };
  if (node.type === "object" || node.properties) return { kind: "object" };
  if (node.$ref) return { kind: "object" };
  return { kind: "any" };
}

function propSignatures(schema: unknown, defs: Record<string, unknown>): Record<string, PropSig> {
  if (!schema || typeof schema !== "object") return {};
  const node = schema as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(node.required ?? []);
  const out: Record<string, PropSig> = {};
  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    const kind = propKind(prop, defs);
    out[name] = { kind: kind.kind, ...(kind.enum ? { enum: kind.enum } : {}), required: required.has(name) };
  }
  return out;
}

function schemaDifferences(nodeSchema: { $defs?: Record<string, unknown> }, uiSchema: { $defs?: Record<string, unknown> }): string[] {
  const nodeDefs = nodeSchema.$defs ?? {};
  const uiDefs = uiSchema.$defs ?? {};
  const names = Object.keys(nodeDefs).filter((name) => name in uiDefs && !name.startsWith("__"));
  const differences: string[] = [];
  for (const name of names.sort()) {
    const left = propSignatures(nodeDefs[name], nodeDefs);
    const right = propSignatures(uiDefs[name], uiDefs);
    const props = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const prop of [...props].sort()) {
      const a = left[prop];
      const b = right[prop];
      if (!a || !b) {
        differences.push(`${name}.${prop} missing on ${a ? "ui" : "node"}`);
        continue;
      }
      if (a.required !== b.required) differences.push(`${name}.${prop} required ${a.required} vs ${b.required}`);
      if (a.kind !== b.kind && a.kind !== "any" && b.kind !== "any") differences.push(`${name}.${prop} kind ${a.kind} vs ${b.kind}`);
      if (a.enum && b.enum && a.enum.join("|") !== b.enum.join("|")) differences.push(`${name}.${prop} enum ${a.enum.join("|")} vs ${b.enum.join("|")}`);
    }
  }
  return differences;
}

describe("live chunk budget", () => {
  it("checks the built chunk when dist exists", async () => {
    const dist = path.resolve(uiSrc, "../dist/assets");
    let present = false;
    try {
      present = statSync(dist).isDirectory();
    } catch {
      present = false;
    }
    if (!present) return;
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["ui/scripts/check-live-chunk-budget.mjs"], {
      cwd: path.resolve(uiSrc, "../.."),
      encoding: "utf8",
    });
    if (result.status === 2) return;
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
