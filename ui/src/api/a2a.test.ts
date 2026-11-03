import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A2aApiError,
  a2aApi,
  projectA2aCaller,
  projectA2aPublication,
  projectA2aStatus,
  publicationBody,
  type A2aPublication,
  type A2aStatus,
} from "./a2a";
import { A2aPage } from "../redesign/a2a/A2aPage";
import { A2aScreen, type A2aScreenProps } from "../redesign/a2a/A2aScreen";
import { NewTokenNotice } from "../redesign/a2a/A2aParts";
import { A2aTurnOn } from "../redesign/a2a/A2aTurnOn";
import {
  a2aErrorCopy,
  a2aScreen,
  answerableStages,
  callerNameProblem,
  defaultResultStage,
  newPublication,
  newPublicationReady,
  publicationIdProblem,
  slugifyId,
  terminalStages,
  artifactsOf,
  type NewPublicationForm,
  callingAgentSnippet,
  publicationDirty,
  toggleCaller,
  PUBLIC_URL_MISSING_COPY,
  TOKEN_ONCE_COPY,
} from "../redesign/a2a/a2aView";
import { parseHash } from "../routes";
import { railActiveId } from "../routeNav";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const enabledStatus: A2aStatus = {
  state: "enabled",
  configPath: "/home/a2a.yaml",
  error: null,
  publicUrl: "https://ws.stage-flow.dev",
  agentCardUrl: "https://ws.stage-flow.dev/.well-known/agent-card.json",
  callers: 1,
  publications: 1,
  lastReload: { ok: true, at: "2026-11-03T10:00:00.000Z", error: null },
};

const publication: A2aPublication = {
  id: "supplier_assessment",
  name: "Assess a supplier",
  description: "Research a supplier.",
  projectRoot: "proj",
  pipeline: "supplier.pipeline.yaml",
  goal: "Produce an assessment.",
  inputSchema: "supplier.schema.json",
  allowedCallers: ["acme"],
  resultStage: "final_report",
  includePayload: true,
  artifacts: ["assessment.md"],
  callerAnswerableStages: ["clarify"],
  repository: null,
  ref: null,
};

const noop = () => undefined;

function screenProps(overrides: Partial<A2aScreenProps>): A2aScreenProps {
  return {
    screen: "ready",
    status: enabledStatus,
    callers: [{ id: "acme", tokenSource: "store" }],
    publications: [publication],
    tab: "callers",
    busy: false,
    now: Date.parse("2026-11-03T10:05:00.000Z"),
    loadError: null,
    actionError: null,
    issued: null,
    onTab: noop,
    onRetry: noop,
    onEnable: noop,
    onDisable: noop,
    onReload: noop,
    onAddCaller: noop,
    onRevokeCaller: noop,
    onPublicationSaved: noop,
    onRemovePublication: noop,
    onDismissToken: noop,
    ...overrides,
  };
}

const render = (overrides: Partial<A2aScreenProps>) => renderToStaticMarkup(createElement(A2aScreen, screenProps(overrides)));

describe("A2A routing", () => {
  it("is reachable at #/a2a and lights its rail item", () => {
    expect(parseHash("#/a2a")).toEqual({ name: "a2a" });
    expect(railActiveId({ name: "a2a" }, true)).toBe("a2a");
  });
});

describe("A2A screen state", () => {
  const off = { ...enabledStatus, state: "disabled" as const };
  it("derives the state from the status and the callers", () => {
    expect(a2aScreen({ loading: true, loadError: null, status: null, callers: [] })).toBe("loading");
    expect(a2aScreen({ loading: false, loadError: "request_failed", status: null, callers: [] })).toBe("error");
    expect(a2aScreen({ loading: false, loadError: null, status: off, callers: [] })).toBe("off");
    expect(a2aScreen({ loading: false, loadError: null, status: { ...enabledStatus, state: "configuration_error" }, callers: [] })).toBe("configuration_error");
    expect(a2aScreen({ loading: false, loadError: null, status: enabledStatus, callers: [] })).toBe("no_callers");
    expect(a2aScreen({ loading: false, loadError: null, status: enabledStatus, callers: [{ id: "acme", tokenSource: "store" }] })).toBe("ready");
  });

  it("starts as loading before the first status arrives", () => {
    const html = renderToStaticMarkup(createElement(A2aPage));
    expect(html).toContain("Loading");
    expect(html).toContain("A2A");
  });

  it("off: offers Turn on A2A and says what it does", () => {
    const html = render({ screen: "off", status: { ...off, configPath: "" } });
    expect(html).toContain("Turn on A2A for this Host");
    expect(html).toContain(">Turn on A2A<");
    expect(html).not.toContain("Agent card address");
  });

  it("off with data kept: says it is kept and restores on turn on", () => {
    const html = render({ screen: "off", status: off });
    expect(html).toContain("A2A is turned off");
    expect(html).toContain("kept");
    expect(html).toContain(">Turn on A2A<");
  });

  it("turning on with no public address explains it instead of showing an address", () => {
    const html = renderToStaticMarkup(createElement(A2aTurnOn, { kept: false, busy: false, errorCode: "a2a_public_url_required", onEnable: noop }));
    expect(html).toContain("This Host has no public address");
    expect(html).toContain("STAGEFLOW_PUBLIC_URL");
    expect(html).not.toContain("https://");
    expect(a2aErrorCopy("a2a_public_url_required").hint).toBe(PUBLIC_URL_MISSING_COPY);
  });

  it("on with no callers: shows the addresses with copy buttons and the empty callers state", () => {
    const html = render({ screen: "no_callers", callers: [], publications: [] });
    expect(html).toContain("https://ws.stage-flow.dev/.well-known/agent-card.json");
    expect(html).toContain("Agent card address");
    expect(html).toContain(">Copy<");
    expect(html).toContain("No callers yet");
    expect(html).toContain("Add caller");
  });

  it("on with callers: lists callers and which pipelines each may call", () => {
    const html = render({ screen: "ready" });
    expect(html).toContain(">acme<");
    expect(html).toContain("supplier_assessment");
    expect(html).toContain("Revoke…");
  });

  it("lists published pipelines with their callers, and an empty state without any", () => {
    const html = render({ tab: "publications" });
    expect(html).toContain("Assess a supplier");
    expect(html).toContain("supplier.pipeline.yaml");
    expect(html).toContain("Edit");
    expect(render({ tab: "publications", publications: [] })).toContain("No pipelines published");
  });

  it("status tab: counts, last load, snippet with a placeholder token and the turn-off button", () => {
    const html = render({ tab: "status" });
    expect(html).toContain("A2A is on");
    expect(html).toContain("/home/a2a.yaml");
    expect(html).toContain("Authorization: Bearer &lt;caller token&gt;");
    expect(html).toContain("Copy snippet");
    expect(html).toContain("Turn off A2A");
    expect(callingAgentSnippet(enabledStatus.agentCardUrl)).toContain(enabledStatus.agentCardUrl);
  });

  it("configuration error: shows the Host's message and a reload button", () => {
    const html = render({
      screen: "configuration_error",
      status: { ...enabledStatus, state: "configuration_error", error: { code: "a2a_configuration_error", message: "Caller acme has no token digest" } },
    });
    expect(html).toContain("A2A has a configuration error");
    expect(html).toContain("Caller acme has no token digest");
    expect(html).toContain("Reload configuration");
  });

  it("error: shows the code and a retry", () => {
    const html = render({ screen: "error", status: null, loadError: "request_failed" });
    expect(html).toContain("Could not reach the Host.");
    expect(html).toContain("request_failed");
    expect(html).toContain("Retry");
  });

  it("shows an action error with its code on the page", () => {
    const html = render({ actionError: { code: "a2a_caller_exists", detail: "" } });
    expect(html).toContain("A caller with this name already exists.");
  });
});

describe("caller tokens", () => {
  it("shows the token with the one-time warning only while it is held", () => {
    const shown = render({ issued: { caller: "acme", token: TOKEN } });
    expect(shown).toContain(TOKEN);
    expect(shown).toContain("Copy token");
    expect(shown).toContain("shown once");
    const gone = render({ issued: null, tab: "status" });
    expect(gone).not.toContain(TOKEN);
    expect(renderToStaticMarkup(createElement(NewTokenNotice, { caller: "acme", token: TOKEN, onDismiss: noop }))).toContain(TOKEN);
    expect(TOKEN_ONCE_COPY).toContain("cannot be shown again");
  });

  it("returns the token only from createCaller and never from a listing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "acme", token: TOKEN, token_source: "store" }, 201))
      .mockResolvedValueOnce(jsonResponse({ callers: [{ id: "acme", token_source: "store", token: TOKEN }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await a2aApi.createCaller("acme")).toEqual({ id: "acme", token: TOKEN });
    const listed = await a2aApi.callers();
    expect(listed).toEqual([{ id: "acme", tokenSource: "store" }]);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(JSON.stringify(projectA2aCaller({ id: "acme", token: TOKEN }))).not.toContain(TOKEN);
  });

  it("keeps the token out of the status and the status snippet", () => {
    expect(JSON.stringify(projectA2aStatus({ state: "enabled", token: TOKEN, publicUrl: "https://x.example" }))).not.toContain(TOKEN);
  });
});

describe("caller names", () => {
  it("accepts the Host's rule and flags duplicates", () => {
    expect(callerNameProblem("", [])).toBeNull();
    expect(callerNameProblem("procurement-assistant", [])).toBeNull();
    expect(callerNameProblem("-bad", [])).not.toBeNull();
    expect(callerNameProblem("has space", [])).not.toBeNull();
    expect(callerNameProblem("a".repeat(81), [])).not.toBeNull();
    expect(callerNameProblem("acme", ["acme"])).toContain("already exists");
  });
});

describe("publication editing", () => {
  it("ticks callers and tracks changes", () => {
    expect(toggleCaller(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleCaller(["a", "b"], "a", false)).toEqual(["b"]);
    expect(publicationDirty(publication, "Research a supplier.", ["acme"])).toBe(false);
    expect(publicationDirty(publication, "Changed", ["acme"])).toBe(true);
    expect(publicationDirty(publication, "Research a supplier.", [])).toBe(true);
  });

  it("projects the API shape and builds a preview body without the revision", () => {
    const view = projectA2aPublication({
      id: "p",
      name: "P",
      description: "d",
      project_root: "proj",
      pipeline: "a.pipeline.yaml",
      goal: "g",
      allowed_callers: ["acme"],
      input_schema: "s.json",
      results: { stage: "done", include_payload: false, artifacts: ["x.md"] },
      caller_answerable_stages: [],
      revision: "abc",
    });
    expect(view.allowedCallers).toEqual(["acme"]);
    expect(publicationBody(view)).toEqual({
      id: "p",
      name: "P",
      description: "d",
      project_root: "proj",
      pipeline: "a.pipeline.yaml",
      goal: "g",
      allowed_callers: ["acme"],
      input_schema: "s.json",
      results: { stage: "done", include_payload: false, artifacts: ["x.md"] },
      caller_answerable_stages: [],
    });
  });
});

describe("A2A API client", () => {
  it("calls the routes with the right methods and bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ state: "disabled" }));
    vi.stubGlobal("fetch", fetchMock);
    await a2aApi.enable();
    await a2aApi.disable();
    await a2aApi.reload();
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method]);
    expect(calls).toEqual([
      ["/api/a2a/enable", "POST"],
      ["/api/a2a/disable", "POST"],
      ["/api/a2a/reload", "POST"],
    ]);
  });

  it("patches only the description and the allowed callers, and revokes by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ removed_from: ["p"], revoked: true }));
    vi.stubGlobal("fetch", fetchMock);
    await a2aApi.updatePublication("p q", { description: "d", allowedCallers: ["acme"] });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/a2a/publications/p%20q");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ description: "d", allowed_callers: ["acme"] });
    expect(await a2aApi.revokeCaller("acme")).toEqual({ removedFrom: ["p"] });
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });

  it("raises the Host's code, and http_<status> when there is none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ code: "a2a_public_url_required", error: "x" }, 400)).mockResolvedValueOnce(jsonResponse({}, 502)));
    await expect(a2aApi.enable()).rejects.toMatchObject({ code: "a2a_public_url_required", status: 400 });
    await expect(a2aApi.status()).rejects.toBeInstanceOf(A2aApiError);
  });
});

const stageOptions = [
  { id: "clarify", terminal: false, artifacts: [], freeTextOnly: true },
  { id: "review", terminal: false, artifacts: [], freeTextOnly: false },
  { id: "final_report", terminal: true, artifacts: ["assessment.md"], freeTextOnly: false },
];

const filledForm: NewPublicationForm = {
  projectRoot: "proj",
  pipeline: "supplier.pipeline.yaml",
  name: "Assess a Supplier!",
  goal: "Produce an assessment.",
  description: "Research a supplier.",
  inputSchema: "supplier.schema.json",
  resultStage: "final_report",
  includePayload: true,
  artifacts: ["assessment.md"],
  answerable: [],
  allowedCallers: ["acme"],
};

describe("publishing a pipeline", () => {
  it("makes the id from the name and refuses a taken or empty one", () => {
    expect(slugifyId("Assess a Supplier!")).toBe("assess-a-supplier");
    expect(slugifyId("  --A__b--  ")).toBe("a-b");
    expect(slugifyId("***")).toBe("");
    expect(publicationIdProblem("", [])).toBeNull();
    expect(publicationIdProblem("***", [])).not.toBeNull();
    expect(publicationIdProblem("Assess a supplier", ["assess-a-supplier"])).toContain("already exists");
  });

  it("selects the result stage on its own only when exactly one stage is terminal", () => {
    expect(terminalStages(stageOptions).map((stage) => stage.id)).toEqual(["final_report"]);
    expect(defaultResultStage(stageOptions)).toBe("final_report");
    expect(defaultResultStage([...stageOptions, { id: "alt", terminal: true, artifacts: [], freeTextOnly: false }])).toBe("");
    expect(defaultResultStage([stageOptions[0]!])).toBe("");
  });

  it("offers declared files of the result stage and only free-text-only stages as answerable", () => {
    expect(artifactsOf(stageOptions, "final_report")).toEqual(["assessment.md"]);
    expect(artifactsOf(stageOptions, "clarify")).toEqual([]);
    expect(answerableStages(stageOptions).map((stage) => stage.id)).toEqual(["clarify"]);
  });

  it("is ready only when everything needed is chosen, and builds the API shape", () => {
    expect(newPublicationReady(filledForm, [])).toBe(true);
    expect(newPublicationReady({ ...filledForm, inputSchema: "" }, [])).toBe(false);
    expect(newPublicationReady({ ...filledForm, resultStage: "" }, [])).toBe(false);
    expect(newPublicationReady({ ...filledForm, goal: " " }, [])).toBe(false);
    expect(newPublicationReady(filledForm, ["assess-a-supplier"])).toBe(false);
    expect(publicationBody(newPublication(filledForm))).toEqual({
      id: "assess-a-supplier",
      name: "Assess a Supplier!",
      description: "Research a supplier.",
      project_root: "proj",
      pipeline: "supplier.pipeline.yaml",
      goal: "Produce an assessment.",
      allowed_callers: ["acme"],
      input_schema: "supplier.schema.json",
      results: { stage: "final_report", include_payload: true, artifacts: ["assessment.md"] },
      caller_answerable_stages: [],
    });
  });

  it("offers Publish a pipeline in the empty and the filled list", () => {
    expect(render({ tab: "publications", publications: [] })).toContain("Publish a pipeline");
    expect(render({ tab: "publications" })).toContain("Publish a pipeline");
  });

  it("calls the schema, stage and create routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: ["a.json"], truncated: true }))
      .mockResolvedValueOnce(jsonResponse({ stages: stageOptions }))
      .mockResolvedValueOnce(jsonResponse({ id: "assess-a-supplier" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    expect(await a2aApi.schemaFiles("my root")).toEqual({ files: ["a.json"], truncated: true });
    expect(await a2aApi.pipelineStages("my root", "p/x.pipeline.yaml")).toEqual(stageOptions);
    await a2aApi.createPublication(newPublication(filledForm));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/catalog/files?project_root=my%20root&ext=.json",
      "/api/a2a/pipeline-stages?project_root=my%20root&pipeline=p%2Fx.pipeline.yaml",
      "/api/a2a/publications",
    ]);
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: "POST" });
  });
});
