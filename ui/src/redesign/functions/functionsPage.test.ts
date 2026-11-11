import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { PipelineEditorInspector } from "../editor/PipelineEditorInspector";
import { functionsApi, FunctionApiError } from "../../api/functions";
import { FunctionsDirectoryPage } from "./FunctionsDirectoryPage";
import { FunctionEditorPage } from "./FunctionEditorPage";
import { placeFunction } from "./functionAttachments";
import { filterFunctions, searchFunctions } from "./functionsDirectoryModel";
import { deleteUnreferenced, saveOrSurfaceConflict, testRequestBody } from "./functionsPageModel";
import type { FunctionSummary } from "../../api/functions";

const ROWS: FunctionSummary[] = [
  {
    id: "score",
    name: "Score check",
    description: "Checks a report",
    kind: "verification",
    revision: 2,
    issues: [],
    updatedAt: "2026-11-11T00:00:00.000Z",
  },
  {
    id: "pick_route",
    name: "Pick route",
    description: null,
    kind: "routing",
    revision: 1,
    issues: [],
    updatedAt: "2026-11-11T00:00:00.000Z",
  },
  {
    id: "total_counts",
    name: "Total counts",
    description: null,
    kind: "tool",
    revision: 1,
    issues: [],
    updatedAt: "2026-11-11T00:00:00.000Z",
  },
];

const SOURCE_ISSUE = {
  path: "source",
  code: "function.invalid_source",
  message: "Source must be a JavaScript module that exports default function execute",
};

const SAVED_SOURCE = "export default function execute(context) {\n  return { passed: true };\n}\n";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

afterEach(() => vi.unstubAllGlobals());

describe("functions directory", () => {
  it("searches by name and filters by kind", () => {
    expect(searchFunctions(filterFunctions(ROWS, "verification"), "score").map((row) => row.id)).toEqual(["score"]);
    expect(searchFunctions(filterFunctions(ROWS, "tool"), "score")).toEqual([]);
    expect(searchFunctions(filterFunctions(ROWS, "all"), "total").map((row) => row.id)).toEqual(["total_counts"]);

    const html = render(createElement(FunctionsDirectoryPage, { loaded: ROWS, query: "score", kind: "verification" }));
    expect(html).toContain("Score check");
    expect(html).not.toContain("Pick route");
    expect(html).not.toContain("Total counts");
    expect(html).toContain('aria-label="Search functions"');
    expect(html).toContain("Verification");
    expect(html).toContain("Routing");
    expect(html).toContain("Tool");
  });

  it("asks before deleting an unreferenced function and refreshes the list", async () => {
    const html = render(createElement(FunctionsDirectoryPage, { loaded: ROWS, pendingDeleteId: "score" }));
    expect(html).toContain("Delete Score check?");
    expect(html).toContain("Delete");

    expect(await deleteUnreferenced("score", false)).toEqual({ confirm: true });

    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") return jsonResponse(200, { deleted: true });
      return jsonResponse(200, { functions: ROWS.filter((row) => row.id !== "score") });
    });
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = await deleteUnreferenced("score", true);
    expect(refreshed).toEqual({ functions: ROWS.filter((row) => row.id !== "score") });
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["DELETE", "/api/functions/score"],
      ["GET", "/api/functions"],
    ]);
  });
});

describe("function editor", () => {
  it("shows the API syntax error for a broken export default and does not save a revision", async () => {
    const html = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          id: "score",
          name: "Score check",
          description: "Checks a report",
          kind: "verification",
          revision: 2,
          createdAt: "2026-11-11T00:00:00.000Z",
          updatedAt: "2026-11-11T00:00:00.000Z",
          issues: [SOURCE_ISSUE],
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: "export default",
            timeout_ms: 5000,
            capabilities: [],
            bindings: [],
          },
          yaml: null,
          sourceHash: null,
          contractVersion: null,
        },
      }),
    );
    expect(html).toContain(SOURCE_ISSUE.message);
    expect(html).toContain("Revision 2");
    expect(html).toContain("export default");
    expect(html).not.toContain("Revision 3");

    const fetchMock = vi.fn(async () =>
      jsonResponse(422, { code: "function.invalid", message: "Function definition is invalid", issues: [SOURCE_ISSUE] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const saved = await saveOrSurfaceConflict("score", 2, {
      id: "score",
      name: "Score check",
      kind: "verification",
      source: "export default",
      timeout_ms: 5000,
      capabilities: [],
      bindings: [],
    });
    expect(saved).toMatchObject({ ok: false, kind: "invalid", revision: 2, issues: [SOURCE_ISSUE] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(functionsApi.save("score", { baseRevision: 2, definition: {} })).rejects.toBeInstanceOf(FunctionApiError);
  });

  it("keeps the real-scope choice off until the operator turns it on", () => {
    const html = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          id: "score",
          name: "Score check",
          description: null,
          kind: "verification",
          revision: 1,
          createdAt: "2026-11-11T00:00:00.000Z",
          updatedAt: "2026-11-11T00:00:00.000Z",
          issues: [],
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: SAVED_SOURCE,
            timeout_ms: 5000,
            capabilities: [],
            bindings: [],
          },
          yaml: null,
          sourceHash: "abc",
          contractVersion: 1,
        },
      }),
    );
    expect(html).toContain('aria-label="Use real files, environment, and APIs"');
    expect(html).toContain('aria-checked="false"');
    expect(testRequestBody({ input: { threshold: 1 }, real: false })).toEqual({ input: { threshold: 1 } });
    expect(testRequestBody({ input: { threshold: 1 }, real: true })).toEqual({ input: { threshold: 1 }, real: true });
  });

  it("surfaces the current revision when a save conflicts", async () => {
    const current = {
      id: "score",
      name: "Score check",
      description: null,
      kind: "verification" as const,
      revision: 4,
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      issues: [],
      definition: {
        id: "score",
        name: "Score check",
        kind: "verification" as const,
        source: SAVED_SOURCE,
        timeout_ms: 5000,
        capabilities: [],
        bindings: [],
      },
      yaml: null,
      sourceHash: "abc",
      contractVersion: 1,
    };
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "PUT") return jsonResponse(409, { code: "function.conflict", message: "The function changed since it was loaded", current_revision: 4 });
      return jsonResponse(200, current);
    });
    vi.stubGlobal("fetch", fetchMock);
    const saved = await saveOrSurfaceConflict("score", 2, { ...current.definition, source: "export default" });
    expect(saved).toMatchObject({ ok: false, kind: "conflict", detail: { revision: 4 } });
    if (!saved.ok && saved.kind === "conflict") expect(saved.detail.definition?.source).toBe(SAVED_SOURCE);
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["PUT", "/api/functions/score"],
      ["GET", "/api/functions/score"],
    ]);

    const html = render(createElement(FunctionEditorPage, { functionId: "score", loaded: current }));
    expect(html).toContain("Revision 4");
    expect(html).toContain("return { passed: true }");
  });
});

describe("pipeline function slots", () => {
  it("rejects a routing function dropped onto a tool slot and links the definition", () => {
    const finding = placeFunction("tool", { id: "pick_route", kind: "routing" });
    expect(finding).toEqual({
      ok: false,
      message: 'A routing function cannot be attached as a tool.',
      href: "/functions/pick_route",
    });
    expect(placeFunction("tool", { id: "total_counts", kind: "tool" })).toEqual({ ok: true });

    const draft: DraftPackagePayload = {
      pipeline: {
        id: "demo",
        stages: [
          {
            id: "decide",
            system_prompt: "Decide.",
            route: [{ to: "next" }],
            tools: { functions: [{ id: "pick_route", grants: [] }] },
          },
        ],
      },
    };
    const html = render(
      createElement(PipelineEditorInspector, {
        draft,
        selectedStageId: "decide",
        findings: [],
        defaultModel: null,
        pipelines: [],
        functions: ROWS,
        onDraftChange: () => {},
        onRenameStage: () => {},
      }),
    );
    expect(html).toContain('data-testid="function-slot-finding"');
    expect(html).toContain('href="#/functions/pick_route"');
    expect(html).toContain("A routing function cannot be attached as a tool.");
  });
});
