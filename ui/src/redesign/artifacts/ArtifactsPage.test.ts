import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { ArtifactsPageView } from "./ArtifactsPage";
import {
  DEFAULT_ARTIFACT_LIST_FILTERS,
  artifactListRows,
  unregisteredProjectLabel,
} from "./artifactsPageModel";

const defaultViewProps = {
  filters: DEFAULT_ARTIFACT_LIST_FILTERS,
  onFiltersChange: () => {},
  tabCounts: { all: 0, live: 0, static: 0 },
};

function record(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key: "stage:sales:summarize/weekly",
    id: "weekly",
    title: "weekly.md",
    description: null,
    tags: [],
    kind: "static.markdown",
    origin: "indexed",
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    source: { run_id: "run_abcdef123456", stage_id: "summarize", attempt: 1, session_id: null },
    version: 1,
    size_bytes: 12,
    content_type: "text/markdown",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T12:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "examples", registered: true },
    ...patch,
  };
}

describe("ArtifactsPageView", () => {
  it("renders the empty state", () => {
    const html = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      rows: [],
      error: null,
      loading: false,
      scopeOptions: [{ id: "workspace", label: "Workspace" }, { id: "", label: "All projects" }],
      scopeId: "workspace",
      showLoadMore: false,
    }));
    expect(html).toContain("No artifacts yet");
    expect(html).toContain("data-testid=\"artifacts-empty\"");
    expect(html).toContain("All projects");
  });

  it("renders the unregistered project pill", () => {
    const rows = artifactListRows([
      record({ project: { id: "/gone/root", registered: false } }),
    ]);
    const html = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      tabCounts: { all: 1, live: 0, static: 1 },
      rows,
      error: null,
      loading: false,
      scopeOptions: [],
      scopeId: "",
      showLoadMore: false,
    }));
    expect(html).toContain(unregisteredProjectLabel(rows[0]!)!);
    expect(html).toContain("sf-pill--needs");
  });

  it("renders an Expired pill with the short reason", () => {
    const rows = artifactListRows([
      record({
        status: "expired",
        expired_at: "2026-11-01T00:00:00.000Z",
        expired_reason: "run_purged",
      }),
    ]);
    expect(rows[0]?.expired).toBe(true);
    expect(rows[0]?.expiredReason).toBe("Run was purged");
    const html = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      tabCounts: { all: 1, live: 0, static: 1 },
      rows,
      error: null,
      loading: false,
      scopeOptions: [],
      scopeId: "examples",
      showLoadMore: false,
    }));
    expect(html).toContain("sf-pill--fail");
    expect(html).toContain("Expired");
    expect(html).toContain("Run was purged");
  });

  it("renders filter bar and filtered empty state", () => {
    const html = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      filters: { ...DEFAULT_ARTIFACT_LIST_FILTERS, kind: "static.markdown" },
      rows: [],
      error: null,
      loading: false,
      scopeOptions: [],
      scopeId: "workspace",
      showLoadMore: false,
      onClearFilters: () => {},
    }));
    expect(html).toContain("data-testid=\"artifacts-filter-bar\"");
    expect(html).toContain("data-testid=\"artifacts-empty-filtered\"");
    expect(html).toContain("Clear filters");
    expect(html).toContain("No matches");
  });

  it("uses the singular match label and the invalid-query empty state", () => {
    const one = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      filters: { ...DEFAULT_ARTIFACT_LIST_FILTERS, q: "revenue", kind: "static.markdown" },
      rows: [],
      error: null,
      loading: false,
      scopeOptions: [],
      scopeId: "workspace",
      showLoadMore: false,
      matchCount: 1,
    }));
    expect(one).toContain("1 match");
    expect(one).not.toContain("1 matches");
    const none = renderToStaticMarkup(createElement(ArtifactsPageView, {
      ...defaultViewProps,
      filters: { ...DEFAULT_ARTIFACT_LIST_FILTERS, q: "((", kind: "static.markdown" },
      rows: [],
      error: "query has no searchable terms",
      loading: false,
      scopeOptions: [],
      scopeId: "workspace",
      showLoadMore: false,
      onClearFilters: () => {},
    }));
    expect(none).toContain("No matches");
    expect(none).toContain("Try letters or numbers");
    expect(none).toContain("data-testid=\"artifacts-filter-bar\"");
    expect(none).not.toContain("query has no searchable terms");
  });
});
