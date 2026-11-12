import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { PipelineEditorInspector } from "../editor/PipelineEditorInspector";
import { functionsApi, FunctionApiError } from "../../api/functions";
import { FunctionsDirectoryPage } from "./FunctionsDirectoryPage";
import { FunctionEditorPage } from "./FunctionEditorPage";
import { FunctionAttachmentPanel } from "./FunctionAttachmentPanel";
import { placeFunction, staleGrants } from "./functionAttachments";
import { accessFromDefinition, applyAccess } from "./functionAccess";
import { filterFunctions, searchFunctions } from "./functionsDirectoryModel";
import { relativeTime, slugId } from "./functionKinds";
import {
  applyInvocationResponse,
  applyTestErrorResponse,
  applyTestRunResponse,
  clearedTestPanelState,
  deleteUnreferenced,
  followToolFields,
  functionGenerationIsCurrent,
  nextFunctionGeneration,
  saveOrSurfaceConflict,
  shouldClearTestPanel,
  testPanelGenerationKey,
  testRequestBody,
} from "./functionsPageModel";
import type { FunctionCapability, FunctionInvocation, FunctionSummary } from "../../api/functions";

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

describe("functions directory polish", () => {
  it("finds a function by id or description as well as name", () => {
    expect(searchFunctions(ROWS, "pick_route").map((row) => row.id)).toEqual(["pick_route"]);
    expect(searchFunctions(ROWS, "checks a report").map((row) => row.id)).toEqual(["score"]);
    expect(searchFunctions(ROWS, "nothing like this")).toEqual([]);
  });

  it("teaches the three kinds when the project has none and links each to a prefilled editor", () => {
    const html = render(createElement(FunctionsDirectoryPage, { loaded: [] }));
    expect(html).toContain('data-testid="functions-empty"');
    expect(html).toContain('href="#/functions/new?kind=verification"');
    expect(html).toContain('href="#/functions/new?kind=routing"');
    expect(html).toContain('href="#/functions/new?kind=tool"');
  });

  it("shows a definition problem on its row and gives each row a labelled delete control", () => {
    const broken: FunctionSummary[] = [{ ...ROWS[0]!, issues: [SOURCE_ISSUE] }];
    const html = render(createElement(FunctionsDirectoryPage, { loaded: broken }));
    expect(html).toContain(SOURCE_ISSUE.message);
    expect(html).toContain('aria-label="Delete Score check"');
    expect(html).toContain('aria-label="Open Score check"');
  });

  it("slugs a name into an id and words a timestamp relative to now", () => {
    expect(slugId("  Pick Best Route! ")).toBe("pick_best_route");
    expect(slugId("***")).toBe("");
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    expect(relativeTime("2026-11-12T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-11-12T11:15:00.000Z", now)).toBe("45m ago");
    expect(relativeTime("2026-11-12T07:00:00.000Z", now)).toBe("5h ago");
    expect(relativeTime("2026-11-09T12:00:00.000Z", now)).toBe("3d ago");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("function editor polish", () => {
  const detail = {
    id: "score",
    name: "Score check",
    description: null,
    kind: "verification" as const,
    revision: 2,
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

  it("offers a kind picker and a create action for a new function, preselecting the requested kind", () => {
    const html = render(createElement(FunctionEditorPage, { creating: true, initialKind: "routing" }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Create function");
    expect(html).toContain("nextStageIds");
    expect(html).not.toContain("Delete function");
    expect(html).toContain("Save the function first to run a test.");
  });

  it("pre-fills a sample context shaped for the kind and explains that it becomes context", () => {
    const tool = render(createElement(FunctionEditorPage, { functionId: "total_counts", loaded: { ...detail, id: "total_counts", kind: "tool", definition: { ...detail.definition, id: "total_counts", kind: "tool", tool_name: "total_counts", tool_description: "Sum" } } }));
    expect(tool).toContain('aria-label="Sample context"');
    expect(tool).toContain("&quot;input&quot;: {}");
    expect(tool).toContain("context.input");
    const routing = render(createElement(FunctionEditorPage, { functionId: "pick_route", loaded: { ...detail, id: "pick_route", kind: "routing", definition: { ...detail.definition, id: "pick_route", kind: "routing" } } }));
    expect(routing).toContain("&quot;children&quot;");
  });

  it("names the next revision on the save action and fixes the id and kind of a saved function", () => {
    const html = render(createElement(FunctionEditorPage, { functionId: "score", loaded: detail }));
    expect(html).toContain("Save as revision 3");
    expect(html).toContain("No unsaved changes");
    expect(html).toContain("Delete function");
    expect(html).toContain("functions/score.function.yaml");
    expect(html).not.toContain('aria-label="Kind"');
    expect(html).toContain('aria-label="Artifacts"');
  });

  it("puts a field issue under its field and any other issue in a summary", () => {
    const html = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: { ...detail, issues: [SOURCE_ISSUE, { path: "", code: "function.invalid", message: "Catalog is unreadable" }] },
      }),
    );
    expect(html).toContain(SOURCE_ISSUE.message);
    expect(html).toContain("Catalog is unreadable");
    expect(html).toContain("This function has a problem");
    expect(html).toContain("2 to fix");
  });
});

describe("function attachment rows", () => {
  it("flags an attached function the catalog no longer has", () => {
    const draft: DraftPackagePayload = {
      pipeline: {
        id: "demo",
        stages: [{ id: "decide", system_prompt: "Decide.", tools: { functions: [{ id: "deleted_one", grants: [] }] } }],
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
    expect(html).toContain("deleted_one");
    expect(html).toContain("Not found");
  });

  it("asks before granting access and flags an attachment whose grants are stale", () => {
    const readArtifacts: FunctionCapability = { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" };
    const definition = {
      id: "total_counts",
      name: "Total counts",
      kind: "tool" as const,
      source: SAVED_SOURCE,
      timeout_ms: 5000,
      capabilities: [readArtifacts],
      bindings: [],
    };
    expect(staleGrants({ grants: [] }, definition)).toBe(true);
    expect(staleGrants({ grants: [{ id: "artifacts", path: "", root: "artifacts" }] }, definition)).toBe(false);
    expect(staleGrants({ grants: [{ id: "gone" }] }, null)).toBe(false);

    const draft: DraftPackagePayload = {
      pipeline: {
        id: "demo",
        stages: [{ id: "decide", system_prompt: "Decide.", tools: { functions: [{ id: "total_counts", grants: [] }] } }],
      },
    };
    const html = render(
      createElement(FunctionAttachmentPanel, {
        draft,
        stageId: "decide",
        catalog: ROWS,
        definitions: { total_counts: definition },
        initialPending: {
          id: "total_counts",
          name: "Total counts",
          labels: ["Read artifacts"],
          grants: [{ id: "artifacts", root: "artifacts", path: "" }],
          mode: "replace",
          slot: "tool",
        },
        onDraftChange: () => {},
      }),
    );
    expect(html).toContain("Access changed");
    expect(html).toContain("Review");
    expect(html).toContain("Total counts wants: Read artifacts");
    expect(html).toContain("Allow");
    expect(html).toContain("Cancel");
    expect(html).toContain('data-testid="function-attachments"');
  });
});

describe("function editor generations", () => {
  const invocationRow = (id: string): FunctionInvocation => ({
    id,
    functionId: "score",
    kind: "test",
    status: "succeeded",
    code: null,
    revision: 1,
    sourceHash: "abc",
    durationMs: 12,
    createdAt: "2026-11-11T00:00:00.000Z",
  });

  it("drops a stale invocation list when a newer generation is current", () => {
    const ref = { current: 2 };
    const rows = [invocationRow("a")];
    expect(applyInvocationResponse(1, ref, rows, false)).toBeNull();
    expect(applyInvocationResponse(2, ref, rows, false)).toEqual(rows);
  });

  it("clears the list on a failed current fetch and keeps an empty list when the id moved on", () => {
    const ref = { current: 3 };
    expect(applyInvocationResponse(3, ref, undefined, true)).toEqual([]);
    expect(applyInvocationResponse(2, ref, [invocationRow("old")], false)).toBeNull();
  });

  it("still applies an in-flight invocation response when only the source changes", () => {
    const ref = { current: 1 };
    const before = testPanelGenerationKey({
      functionId: "score",
      kind: "verification",
      source: SAVED_SOURCE,
      savedSource: SAVED_SOURCE,
    });
    const after = testPanelGenerationKey({
      functionId: "score",
      kind: "verification",
      source: "export default function execute() { return { passed: false }; }\n",
      savedSource: SAVED_SOURCE,
    });
    expect(shouldClearTestPanel(before, after)).toBe(true);
    expect(ref.current).toBe(1);
    expect(applyInvocationResponse(1, ref, [invocationRow("keep")], false)).toEqual([invocationRow("keep")]);
  });

  it("bumps the invocation generation on fetch start without tying it to source edits", () => {
    const ref = { current: 0 };
    expect(nextFunctionGeneration(ref)).toBe(1);
    expect(functionGenerationIsCurrent(1, ref)).toBe(true);
    expect(functionGenerationIsCurrent(0, ref)).toBe(false);
  });

  it("clears test output when source, saved source, function id, or kind changes but not for sample text", () => {
    const base = {
      functionId: "score",
      kind: "verification" as const,
      source: SAVED_SOURCE,
      savedSource: SAVED_SOURCE,
    };
    const key = testPanelGenerationKey(base);
    expect(shouldClearTestPanel(key, testPanelGenerationKey({ ...base, source: "edited" }))).toBe(true);
    expect(shouldClearTestPanel(key, testPanelGenerationKey({ ...base, savedSource: "other" }))).toBe(true);
    expect(shouldClearTestPanel(key, testPanelGenerationKey({ ...base, functionId: "other" }))).toBe(true);
    expect(shouldClearTestPanel(key, testPanelGenerationKey({ ...base, kind: "tool" }))).toBe(true);
    expect(shouldClearTestPanel(key, key)).toBe(false);
    expect(clearedTestPanelState()).toEqual({ run: null, error: null, busy: false });
  });

  it("ignores a test response from the generation before a source change", () => {
    const ref = { current: 0 };
    const captured = ref.current;
    nextFunctionGeneration(ref);
    const run = {
      ok: true,
      status: "succeeded",
      code: null,
      message: null,
      value: { passed: true },
      logs: "",
      durationMs: 1,
      revision: 1,
      sourceHash: "abc",
      kind: "test",
    };
    expect(applyTestRunResponse(captured, ref, run)).toBeNull();
    expect(applyTestRunResponse(1, ref, run)).toEqual(run);
    expect(applyTestErrorResponse(captured, ref, "failed")).toBeNull();
    expect(applyTestErrorResponse(1, ref, "failed")).toBe("failed");
  });
});

describe("function access editor", () => {
  const base = {
    id: "score",
    name: "Score check",
    description: null,
    kind: "verification" as const,
    revision: 1,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    issues: [],
    yaml: null,
    sourceHash: "abc",
    contractVersion: 1,
  };
  const readApi: FunctionCapability = {
    id: "api_1",
    type: "api",
    origin: "https://api.example.com",
    methods: ["GET"],
    path_prefix: "/",
    effect: "read",
  };

  it("shows access controls for a tool and hides write and action on a verification", () => {
    const tool = render(createElement(FunctionEditorPage, { creating: true, initialKind: "tool" }));
    expect(tool).toContain(">Access<");
    expect(tool).toContain('data-testid="function-contract"');
    expect(tool).toContain('aria-label="Artifacts"');
    expect(tool).toContain("Environment variables");
    expect(tool).toContain("Add variable");
    expect(tool).toContain("Network");
    expect(tool).toContain("Add origin");
    expect(tool).toContain("Read and write");
    expect(tool).toContain("No access. This function can only work on its context.");
    expect(tool).toContain("Defaults to the id.");
    expect(tool).toContain("Defaults to the description.");

    const verification = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          ...base,
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: SAVED_SOURCE,
            timeout_ms: 5000,
            capabilities: [readApi],
            bindings: [],
          },
        },
      }),
    );
    expect(verification).toContain("https://api.example.com");
    expect(verification).toContain("Move access into the source");
    expect(verification).toContain("Attachments will ask you to review access once, because capability ids are now derived from the code.");
    expect(verification).not.toContain("Read and write");
    expect(verification).not.toContain("Action");
  });

  it("binds access controls to a declaration and shows parser issues without rewriting", () => {
    const declared = `export const access = {
  artifacts: "read",
  env: ["MIN_SCORE?"],
  files: [{ root: "artifacts", path: "report.json", access: "read" }],
  network: ["https://api.example.com"],
};
export default function execute(context) { return { passed: true }; }
`;
    const html = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          ...base,
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: declared,
            timeout_ms: 5000,
            capabilities: [],
            bindings: [],
          },
        },
      }),
    );
    expect(html).toContain("Read artifacts");
    expect(html).toContain("Env MIN_SCORE (optional)");
    expect(html).toContain("API https://api.example.com (read)");
    expect(html).toContain("Advanced access");
    expect(html).toContain("report.json");
    expect(html).toContain("Edit these paths in the source.");
    expect(html).toContain('aria-label="Workspace"');
    expect(html).not.toContain("Move access into the source");

    const broken = `export const access = { nope: true };
export default function execute(context) { return { passed: true }; }
`;
    const invalid = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          ...base,
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: broken,
            timeout_ms: 5000,
            capabilities: [],
            bindings: [],
          },
        },
      }),
    );
    expect(invalid).toContain("unknown access key");
    expect(invalid).toContain("nope");
    expect(invalid).toContain("(1:25)");
    expect(invalid).toContain("<fieldset");
    expect(invalid).toContain("disabled");
  });

  it("shows advanced file access and leaves that capability unchanged", () => {
    const reports: FunctionCapability = { id: "reports", type: "file", root: "workspace", path: "reports/", access: "read" };
    const html = render(
      createElement(FunctionEditorPage, {
        functionId: "score",
        loaded: {
          ...base,
          definition: {
            id: "score",
            name: "Score check",
            kind: "verification",
            source: SAVED_SOURCE,
            timeout_ms: 5000,
            capabilities: [reports],
            bindings: [],
          },
        },
      }),
    );
    expect(html).toContain("Advanced access (1)");
    expect(html).toContain("reports/");
    const access = accessFromDefinition([reports], [], "verification");
    expect(access.advanced).toEqual([reports]);
    expect(applyAccess({ capabilities: [reports], bindings: [] }, { ...access, env: [{ alias: "FEED_REGION", required: true, capabilityId: "" }] }, "verification").capabilities[0]).toEqual(reports);
  });

  it("follows the id and description for a new tool until those fields are edited", () => {
    const blank = { id: "total", description: "Add the counts", tool_name: "", tool_description: "" };
    expect(followToolFields(true, "tool", blank, { toolName: false, toolDescription: false })).toEqual({
      tool_name: "total",
      tool_description: "Add the counts",
    });
    expect(followToolFields(true, "tool", { ...blank, tool_name: "custom", tool_description: "Mine" }, { toolName: true, toolDescription: true })).toEqual({
      tool_name: "custom",
      tool_description: "Mine",
    });
    expect(followToolFields(false, "tool", blank, { toolName: false, toolDescription: false })).toEqual({ tool_name: "", tool_description: "" });
    expect(followToolFields(true, "verification", blank, { toolName: false, toolDescription: false })).toEqual({ tool_name: "", tool_description: "" });
  });
});
