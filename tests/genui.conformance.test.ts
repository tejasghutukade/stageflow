import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentPublishArtifactTool } from "../src/agents/artifactTools.js";
import { presentArtifact, presentInline, resetCardLimiterForTests, type PresentArtifactResult } from "../src/genui/present.js";
import { createPiAgentRuntime, type OpenSessionInput, type PiRuntimeOptions } from "../src/agents/runtime/piRuntime.js";
import type { TurnHooks } from "../src/agents/runtime/types.js";
import { ARTIFACT_TITLE_MAX_CHARS } from "../src/artifacts/limits.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { resetSessionArtifactLimiterForTests } from "../src/artifacts/sessionScope.js";
import { CARD_PROGRAM_MAX_BYTES, UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_CARD, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import type { AgentDefinition } from "../src/config/loadAgent.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { createGuidePresentUiTool } from "../src/guide/presentUi.js";
import { createGuideSaveCardTool } from "../src/guide/saveCard.js";
import { createGuideThread, saveGuideThread, type GuideThreadRecord } from "../src/guide/threadStore.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { consoleUrl } from "../src/mcp/writeTarget.js";
import { advanceGuideTurn, guideContextOf } from "../src/operatorAgent/profiles/guideConfirm.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { createPublishArtifactTool } from "../src/tools/publishArtifact.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

/**
 * One table of generative UI cases run against every surface that presents cards today, through the real tool objects.
 * A row that differs between surfaces names the architecture decision (genui plan, AD<n>) that should make it equal;
 * when that step lands, flip the row to the shared expectation.
 */

const previousHome = process.env.STAGEFLOW_HOME;
let fx: AgentsFixture;
let seq = 0;

const CARD_KINDS = ["live.declarative", "static.markdown", "live.html"];
const writeGrant = { tools: { stageflow: { groups: ["artifacts.read", "artifacts.write"] } } };

beforeAll(async () => {
  fx = await agentsFixture();
  process.env.STAGEFLOW_HOME = fx.home;
  resetGlobalStageflowHomeForTests();
  const agents: Record<string, Record<string, unknown>> = {
    conv: { ...writeGrant, ui: { present: true, persistence: "conversation", kinds: CARD_KINDS, functions: [] } },
    arts: { ...writeGrant, ui: { present: true, persistence: "artifacts", kinds: CARD_KINDS, functions: [] } },
  };
  for (const [id, overrides] of Object.entries(agents)) {
    await fx.service.create(fx.project, agentInput(id, overrides), { source: "console" });
    await fx.service.setEnabled(fx.project, id, true, { source: "console" });
  }
});

afterAll(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  await fx?.cleanup();
});

beforeEach(() => {
  resetCardLimiterForTests();
  resetSessionArtifactLimiterForTests();
});

function roots(): CatalogRoot[] {
  return [{ project_root: fx.project, path: fx.project, kind: "registered", read_only: false }];
}

function consoleDeps(): McpToolDeps {
  return { cwd: fx.project, projectRoot: fx.project, manager: {} as never, store: {} as never } as McpToolDeps;
}

// ---------------------------------------------------------------------------------------------------------------
// Surfaces

type Call = { key?: string; title?: string; program?: string; manifest?: Record<string, unknown> };
type Outcome = { ok: true; ui: Record<string, unknown> } | { ok: false; code: string };
type SurfaceName = "agent.conversation" | "agent.artifacts" | "guide";
type CardSurface = {
  reply(calls: readonly Call[], options?: { parallel?: boolean }): Promise<Outcome[]>;
  toolNames(): string[];
};

const SURFACES: readonly SurfaceName[] = ["agent.conversation", "agent.artifacts", "guide"];

function hooks(): TurnHooks {
  return {
    gate: async () => ({ allow: true }),
    toolStarted: () => undefined,
    toolFinished: () => undefined,
    modelFinished: () => undefined,
    delegate: async () => "sub",
  };
}

const assistantEnd = {
  type: "message_end",
  message: { role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cost: { total: 0 } } },
};

/** The Host's presentUi port, as `src/agents/hostContext.ts` wires it, against the fixture store. */
const hostPresentUi: NonNullable<PiRuntimeOptions["presentUi"]> = async (input) => {
  const shared = {
    db: fx.connection,
    roots: roots(),
    projectRoot: input.projectRoot,
    ...(input.title !== undefined ? { title: input.title } : {}),
    sessionId: input.sessionId,
    agentId: input.agentId,
    presentedInMessage: input.presentedInMessage,
    allowedKinds: input.kinds,
    consoleUrl: (hashPath: string) => consoleUrl(consoleDeps(), hashPath),
  };
  if (typeof input.program === "string") return presentInline({ ...shared, program: input.program, manifest: input.manifest });
  if (!input.key) return { ok: false, code: "artifact.invalid_id", message: "Artifact key is not valid" } satisfies PresentArtifactResult;
  return presentArtifact({ ...shared, key: input.key, ...(input.version !== undefined ? { version: input.version } : {}) });
};

async function definitionOf(agentId: string): Promise<AgentDefinition> {
  const record = await fx.service.get(fx.project, agentId);
  if (!record.definition) throw new Error(`agent ${agentId} has no definition`);
  return record.definition;
}

function toOutcome(result: { details: Record<string, unknown>; isError?: true }): Outcome {
  if (result.isError) return { ok: false, code: String(result.details.code) };
  return { ok: true, ui: result.details.ui as Record<string, unknown> };
}

/** A project agent driven through createPiAgentRuntime with a fake Pi session: each reply runs the calls through the session's present_ui tool. */
async function agentSurface(agentId: "conv" | "arts", htmlCards: boolean): Promise<CardSurface> {
  const definition = await definitionOf(agentId);
  const sessionId = `ses_conformance_${agentId}_${seq++}`;
  let pending: readonly Call[] = [];
  let parallel = false;
  let outcomes: Outcome[] = [];
  let opened: OpenSessionInput | undefined;
  const runtime = createPiAgentRuntime({
    cwd: fx.project,
    agentDir: fx.home,
    idleReleaseMs: 0,
    htmlCardsAvailable: htmlCards,
    presentUi: hostPresentUi,
    openSession: async (input) => {
      opened = input;
      return {
        toolNames: input.toolNames,
        shutdown: async () => undefined,
        session: {
          subscribe: (listener: (event: unknown) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          prompt: async () => {
            const tool = input.presentUiTool;
            if (!tool) throw new Error("present_ui was not offered");
            const run = async (call: Call) => toOutcome(await tool.execute(`call_${seq++}`, call));
            if (parallel) outcomes = await Promise.all(pending.map(run));
            else {
              outcomes = [];
              for (const call of pending) outcomes.push(await run(call));
            }
            listeners.forEach((listener) => listener(assistantEnd));
          },
          dispose: () => undefined,
          abort: async () => undefined,
        },
      } as never;
    },
  });
  const listeners = new Set<(event: unknown) => void>();
  return {
    async reply(calls, options = {}) {
      pending = calls;
      parallel = options.parallel === true;
      await runtime.complete({
        sessionId,
        projectRoot: fx.project,
        definition,
        messages: [{ role: "user", text: "draw it" }],
        signal: new AbortController().signal,
        onDelta: () => undefined,
        hooks: hooks(),
      });
      return outcomes;
    },
    toolNames: () => opened?.toolNames ?? [],
  };
}

/** The Guide's present_ui operator tool, with a session context that advances per person message like the Guide chat. */
function guideSurface(htmlCards: boolean): CardSurface {
  const tool = createGuidePresentUiTool(consoleDeps(), { htmlCardsAvailable: htmlCards });
  let context: unknown = guideContextOf({ kind: "stageflow_guide", turn: 0, confirmations: [], threadId: `thread_conformance_${seq++}` });
  const ctx = {
    getContext: () => context,
    setContext: (next: unknown) => {
      context = next;
    },
    emitProposal: () => undefined,
  };
  return {
    async reply(calls, options = {}) {
      context = advanceGuideTurn(context);
      const run = async (call: Call): Promise<Outcome> => {
        const result = await tool.handler(call as Record<string, unknown>, ctx);
        if (!result.ok) return { ok: false, code: String(result.error) };
        return { ok: true, ui: (result.content as { ui: Record<string, unknown> }).ui };
      };
      if (options.parallel) return Promise.all(calls.map(run));
      const outcomes: Outcome[] = [];
      for (const call of calls) outcomes.push(await run(call));
      return outcomes;
    },
    toolNames: () => [tool.name],
  };
}

async function surface(name: SurfaceName, htmlCards = true): Promise<CardSurface> {
  if (name === "agent.conversation") return agentSurface("conv", htmlCards);
  if (name === "agent.artifacts") return agentSurface("arts", htmlCards);
  return guideSurface(htmlCards);
}

// ---------------------------------------------------------------------------------------------------------------
// Programs

const declarative = 'root = Card([CardHeader("Regional sales", "This week"), TextContent("North leads.")])';
const declarativeManifest = { kind: "live.declarative", format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] };
const markdown = "# Weekly notes\n\n- North leads";
const html = "<p>North 120, South 95</p>";
const htmlManifest = { kind: "live.html", format: "html", libraries: [{ name: "chartjs", version: "4.6.2" }] };
const oversizeDeclarative = `${declarative}${"\n".repeat(CARD_PROGRAM_MAX_BYTES)}`;

/** Expected verdict: "card", "artifact-ref" or an error code. */
type Verdict = "card" | "artifact-ref" | (string & {});
type Expectation = { verdict: Verdict; note?: string };

function verdictOf(outcome: Outcome | undefined): Verdict {
  if (!outcome) return "missing";
  if (!outcome.ok) return outcome.code;
  return outcome.ui.kind === UI_PART_KIND_CARD ? "card" : outcome.ui.kind === UI_PART_KIND_ARTIFACT_REF ? "artifact-ref" : `ui:${String(outcome.ui.kind)}`;
}

function assertShape(outcome: Outcome, call: Call): void {
  if (!outcome.ok) return;
  expect(outcome.ui.v).toBe(UI_PART_SCHEMA_VERSION);
  expect(typeof outcome.ui.title).toBe("string");
  expect(outcome.ui).toHaveProperty("fallback");
  const kind = call.manifest?.kind;
  if (outcome.ui.kind === UI_PART_KIND_CARD) {
    expect(outcome.ui).toMatchObject({ format: kind, program: call.program, fallback: { url: "" } });
    if (kind === "live.declarative") expect(outcome.ui.library).toEqual({ name: "stageflow", version: "1.0.0" });
    if (kind === "live.html" && Array.isArray(call.manifest?.libraries)) expect(outcome.ui.libraries).toEqual(call.manifest.libraries);
    if (kind === "static.markdown") expect((outcome.ui.fallback as { text: string }).text).toBe(call.program);
  } else {
    expect(String(outcome.ui.key)).toMatch(/^agent:arts\/c[0-9a-f]{16}$/);
    expect((outcome.ui.fallback as { url: string }).url).toContain("/#/artifacts/");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One card per reply

type CardCase = {
  name: string;
  call: Call;
  htmlCards?: boolean;
  expect: Expectation & { per?: Partial<Record<SurfaceName, Expectation>> };
};

// `persistence: artifacts` is the live-data mode: it saves a session artifact (artifact-ref), allows bindings and network
// csp, and uses artifact caps. Those rows are by design (AD7 keeps the mode), not differences to remove.
const BY_DESIGN_ARTIFACTS = "by design: artifacts mode publishes a session artifact (AD7 keeps this mode)";

const CARD_CASES: CardCase[] = [
  {
    name: "valid live.declarative card",
    call: { title: "Regional sales", program: declarative, manifest: declarativeManifest },
    expect: { verdict: "card", per: { "agent.artifacts": { verdict: "artifact-ref", note: BY_DESIGN_ARTIFACTS } } },
  },
  {
    name: "valid static.markdown card",
    call: { title: "Notes", program: markdown, manifest: { kind: "static.markdown" } },
    expect: { verdict: "card", per: { "agent.artifacts": { verdict: "artifact-ref", note: BY_DESIGN_ARTIFACTS } } },
  },
  {
    name: "valid live.html card with a vendored library (HTML cards reachable)",
    call: { title: "Regional chart", program: html, manifest: htmlManifest },
    htmlCards: true,
    expect: { verdict: "card", per: { "agent.artifacts": { verdict: "artifact-ref", note: BY_DESIGN_ARTIFACTS } } },
  },
  {
    name: "live.html when HTML cards are not reachable",
    call: { title: "Regional chart", program: html, manifest: htmlManifest },
    htmlCards: false,
    expect: {
      verdict: "ui.kind_not_granted",
      per: {
        // differs today; AD4 makes these equal (the HTML-cards-reachable signal only changes the agent prompt, not the tool)
        "agent.conversation": { verdict: "card", note: "differs today; AD4 makes these equal" },
        // differs today; AD4 makes these equal (the reachability signal does not reach the tool)
        "agent.artifacts": { verdict: "artifact-ref", note: "differs today; AD4 makes these equal" },
      },
    },
  },
  {
    name: "missing manifest.kind",
    call: { title: "Runs", program: declarative, manifest: { format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] } },
    expect: {
      verdict: "ui.kind_not_granted",
      // differs today; AD3 makes these equal (presentInline checks kind before the grant)
      per: { "agent.artifacts": { verdict: "artifact.invalid_shape", note: "differs today; AD3 makes these equal" } },
    },
  },
  {
    name: "kind not granted",
    call: { title: "Rows", program: "name\nAda\n", manifest: { kind: "static.table" } },
    expect: { verdict: "ui.kind_not_granted" },
  },
  {
    name: "card with bindings",
    call: { title: "Runs", program: declarative, manifest: { ...declarativeManifest, bindings: [{ id: "rows", function: "weekly", args: {} }] } },
    expect: { verdict: "ui.card_display_only", per: { "agent.artifacts": { verdict: "artifact.binding_unknown_function", note: BY_DESIGN_ARTIFACTS } } },
  },
  {
    name: "HTML card with csp origins",
    call: { title: "Chart", program: html, manifest: { kind: "live.html", format: "html", csp: { connectDomains: ["https://api.example.com"] } } },
    // Artifacts mode accepts csp origins (publish adds the origin approval warning).
    expect: { verdict: "ui.card_display_only", per: { "agent.artifacts": { verdict: "artifact-ref", note: BY_DESIGN_ARTIFACTS } } },
  },
  {
    name: "program over 64 KiB",
    call: { title: "Big", program: oversizeDeclarative, manifest: declarativeManifest },
    expect: { verdict: "artifact.too_large", per: { "agent.artifacts": { verdict: "artifact-ref", note: `${BY_DESIGN_ARTIFACTS}; artifact cap is 128 KiB (AD2 keeps it)` } } },
  },
  {
    name: "invalid declarative program",
    call: { title: "Broken", program: "root = Card([", manifest: declarativeManifest },
    expect: { verdict: "artifact.program_invalid" },
  },
  {
    name: "HTML card with an unknown library version",
    call: { title: "Chart", program: html, manifest: { kind: "live.html", format: "html", libraries: [{ name: "chartjs", version: "0.0.1" }] } },
    expect: { verdict: "ui.unknown_library" },
  },
  {
    name: "a saved artifact key instead of a program",
    call: { key: "agent:arts/missing" },
    expect: {
      verdict: "ui.key_needs_artifacts",
      per: {
        "agent.artifacts": { verdict: "artifact.not_found", note: BY_DESIGN_ARTIFACTS },
        // differs today; AD3 makes these equal (the Guide only checks that program is text)
        guide: { verdict: "artifact.invalid_shape", note: "differs today; AD3 makes these equal" },
      },
    },
  },
];

describe("generative UI conformance: one card", () => {
  for (const testCase of CARD_CASES) {
    for (const name of SURFACES) {
      const expected = testCase.expect.per?.[name] ?? testCase.expect;
      const label = `${testCase.name} on ${name} -> ${expected.verdict}${expected.note ? ` (${expected.note})` : ""}`;
      it(label, async () => {
        const target = await surface(name, testCase.htmlCards ?? true);
        const [outcome] = await target.reply([testCase.call]);
        expect(verdictOf(outcome), JSON.stringify(outcome)).toBe(expected.verdict);
        assertShape(outcome!, testCase.call);
      });
    }
  }

  it("every surface offers the tool as present_ui", async () => {
    for (const name of SURFACES) {
      const target = await surface(name);
      await target.reply([]);
      expect(target.toolNames()).toContain("present_ui");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Per-reply cap

const validCall: Call = { title: "Sales", program: declarative, manifest: declarativeManifest };
const badCall: Call = { title: "Broken", program: "root = Card([", manifest: declarativeManifest };
const ok = (outcome: Outcome) => (outcome.ok ? "ok" : outcome.code);

describe("generative UI conformance: per-reply cap", () => {
  for (const name of SURFACES) {
    it(`refuses the 5th card in one reply with ui.message_cap on ${name}`, async () => {
      const target = await surface(name);
      const outcomes = await target.reply(Array.from({ length: 5 }, () => validCall));
      expect(outcomes.map(ok)).toEqual(["ok", "ok", "ok", "ok", "ui.message_cap"]);
    });

    it(`does not count a failed card toward the cap on ${name}`, async () => {
      const target = await surface(name);
      const outcomes = await target.reply([badCall, validCall, validCall, validCall, validCall, validCall]);
      expect(outcomes.map(ok)).toEqual(["artifact.program_invalid", "ok", "ok", "ok", "ok", "ui.message_cap"]);
    });

    it(`starts the count again in the next reply on ${name}`, async () => {
      const target = await surface(name);
      expect((await target.reply(Array.from({ length: 4 }, () => validCall))).map(ok)).toEqual(["ok", "ok", "ok", "ok"]);
      expect((await target.reply([validCall])).map(ok)).toEqual(["ok"]);
    });
  }

  it("refuses the 5th of five parallel cards on the Guide (slot reserved before awaiting)", async () => {
    const outcomes = await (await surface("guide")).reply(Array.from({ length: 5 }, () => validCall), { parallel: true });
    expect(outcomes.map(ok).sort()).toEqual(["ok", "ok", "ok", "ok", "ui.message_cap"]);
  });

  for (const name of ["agent.conversation", "agent.artifacts"] as const) {
    it(`accepts all five parallel cards on ${name} (differs today; AD5 makes these equal)`, async () => {
      const outcomes = await (await surface(name)).reply(Array.from({ length: 5 }, () => validCall), { parallel: true });
      // differs today; AD5 makes these equal: piRuntime counts inlinePresented after the await, so parallel calls all see slot 1.
      expect(outcomes.map(ok)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Titles

type TitleCase = { name: string; call: Call; card: string; artifacts: string };

const longTitle = "T".repeat(ARTIFACT_TITLE_MAX_CHARS + 30);

const TITLE_CASES: TitleCase[] = [
  { name: "a given title is trimmed", call: { title: "  Sales  ", program: declarative, manifest: declarativeManifest }, card: "Sales", artifacts: "Sales" },
  {
    name: "a long title is cut to the title limit",
    call: { title: longTitle, program: declarative, manifest: declarativeManifest },
    card: longTitle.slice(0, ARTIFACT_TITLE_MAX_CHARS),
    artifacts: longTitle.slice(0, ARTIFACT_TITLE_MAX_CHARS),
  },
  // differs today; AD3 makes these equal if the plan unifies title rules (cards fall back to "Card"; presentInline uses presentedTitle)
  { name: "no title falls back to manifest.title", call: { program: declarative, manifest: { ...declarativeManifest, title: "From manifest" } }, card: "Card", artifacts: "From manifest" },
  // differs today; see above
  { name: "no title falls back to the markdown heading", call: { program: markdown, manifest: { kind: "static.markdown" } }, card: "Card", artifacts: "Weekly notes" },
  // differs today; see above
  { name: "no title and nothing to derive it from", call: { program: declarative, manifest: declarativeManifest }, card: "Card", artifacts: "Chat" },
  { name: "a blank title counts as no title", call: { title: "   ", program: declarative, manifest: declarativeManifest }, card: "Card", artifacts: "Chat" },
];

describe("generative UI conformance: title fallback", () => {
  for (const testCase of TITLE_CASES) {
    for (const name of SURFACES) {
      const expected = name === "agent.artifacts" ? testCase.artifacts : testCase.card;
      const differs = testCase.card !== testCase.artifacts ? " (differs today between cards and artifacts mode)" : "";
      it(`${testCase.name} on ${name} -> ${JSON.stringify(expected.length > 20 ? `${expected.slice(0, 8)}…` : expected)}${differs}`, async () => {
        const [outcome] = await (await surface(name)).reply([testCase.call]);
        expect(outcome?.ok, JSON.stringify(outcome)).toBe(true);
        if (!outcome?.ok) return;
        expect(outcome.ui.title).toBe(expected);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// save_card

describe("generative UI conformance: save_card", () => {
  const saveCleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of saveCleanups.splice(0).reverse()) await cleanup();
    process.env.STAGEFLOW_HOME = fx.home;
    resetGlobalStageflowHomeForTests();
  });

  async function guideSaveSetup() {
    const home = await mkdtemp(path.join(tmpdir(), "sf-genui-save-home-"));
    const dir = await mkdtemp(path.join(tmpdir(), "sf-genui-save-proj-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    const project = await store.ensureProject(dir);
    saveCleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    });
    await catalogRootsForArtifacts(store);
    const thread = createGuideThread();
    const now = new Date().toISOString();
    const cardPart = (id: string, title: string, program: string) => ({
      type: "tool" as const,
      id,
      name: "present_ui",
      status: "complete" as const,
      result: {
        type: "ui",
        ui: { v: UI_PART_SCHEMA_VERSION, kind: "card", title, format: "static.markdown", program, fallback: { text: program, url: "" } },
      },
    });
    const record: GuideThreadRecord = {
      version: 1,
      id: thread.id,
      title: "Cards",
      createdAt: now,
      updatedAt: now,
      messages: [
        { id: "m1", role: "assistant", text: "First.", createdAt: now, parts: [cardPart("card-older", "Older notes", "# Older")] },
        { id: "m2", role: "assistant", text: "Second.", createdAt: now, parts: [cardPart("card-latest", "Latest notes", "# Latest")] },
      ],
    };
    saveGuideThread(record);
    const tool = createGuideSaveCardTool({ cwd: project, manager: {} as never, store, projectRoot: project });
    const ctx = {
      getContext: () => guideContextOf({ kind: "stageflow_guide", turn: 3, confirmations: [], threadId: thread.id }),
      setContext: () => undefined,
      emitProposal: () => undefined,
    };
    const save = async (args: Record<string, unknown>) => {
      const result = await tool.handler(args, ctx);
      if (!result.ok) return { ok: false as const, code: String(result.error) };
      return { ok: true as const, ui: (result.content as { ui: { key: string; title: string; kind: string } }).ui };
    };
    return { save };
  }

  it("Guide: latest, by title, by id and the same card twice give one artifact", async () => {
    const { save } = await guideSaveSetup();
    const latest = await save({});
    const byTitle = await save({ card_id: "LATEST NOTES" });
    const byId = await save({ card_id: "card-latest" });
    const again = await save({});
    const keys = [latest, byTitle, byId, again].map((result) => (result.ok ? result.ui.key : result.code));
    expect(new Set(keys).size, JSON.stringify(keys)).toBe(1);
    expect(keys[0]).toMatch(/^guide\/card_[0-9a-f]{16}$/);
    expect(latest.ok && latest.ui).toMatchObject({ kind: UI_PART_KIND_ARTIFACT_REF, title: "Latest notes" });
    const older = await save({ card_id: "older notes" });
    expect(older.ok && older.ui.key).not.toBe(keys[0]);
    expect(await save({ card_id: "nope" })).toEqual({ ok: false, code: "guide.card_not_found" });
  });

  // AD7: agents with ui.present, persistence conversation and the artifact write grant get save_card in Step 4. Flip to it().
  it.fails("agent (conversation mode, write grant) offers save_card (unsupported today; AD7 adds it)", async () => {
    const target = await surface("agent.conversation");
    await target.reply([]);
    expect(target.toolNames()).toContain("save_card");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// publish_artifact: stage vs agent

type PublishCase = { name: string; params: Record<string, unknown>; verdict: "ok" | (string & {}); warns?: boolean };

const PUBLISH_CASES: PublishCase[] = [
  {
    name: "valid live.declarative",
    params: { kind: "live.declarative", title: "Sales", content: declarative, format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] },
    verdict: "ok",
  },
  {
    name: "valid live.html with a vendored library",
    params: { kind: "live.html", title: "Chart", content: html, format: "html", libraries: [{ name: "chartjs", version: "4.6.2" }] },
    verdict: "ok",
  },
  {
    name: "live.html with csp origins (warns: needs origin approval)",
    params: { kind: "live.html", title: "Chart", content: html, format: "html", csp: { connectDomains: ["https://api.example.com"] } },
    verdict: "ok",
    warns: true,
  },
  {
    name: "invalid declarative program",
    params: { kind: "live.declarative", title: "Broken", content: "root = Card([", format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] },
    verdict: "artifact.program_invalid",
  },
  {
    name: "live.declarative over the 128 KiB program cap",
    params: { kind: "live.declarative", title: "Big", content: `root = Card([TextContent("${"x".repeat(130 * 1024)}")])`, format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] },
    verdict: "artifact.too_large",
  },
  {
    name: "live.html with an unknown library version",
    params: { kind: "live.html", title: "Chart", content: html, format: "html", libraries: [{ name: "chartjs", version: "0.0.1" }] },
    verdict: "artifact.invalid_shape",
  },
  {
    name: "a binding to a function that does not exist",
    params: { kind: "live.declarative", title: "Runs", content: declarative, format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [{ id: "rows", function: "weekly", args: {} }] },
    verdict: "artifact.binding_unknown_function",
  },
  {
    name: "a kind publish does not know",
    params: { kind: "live.form", title: "Form", content: "x" },
    verdict: "artifact.invalid_kind",
  },
];

describe("generative UI conformance: publish_artifact, stage vs agent", () => {
  function stageTool() {
    return createPublishArtifactTool({
      runWorkspaceDir: fx.project,
      stageId: "publish-note",
      attempt: 1,
      publish: (body) =>
        publishSessionArtifact(
          { db: fx.connection, roots: roots() },
          { owner: { kind: "stage", pipeline: "conformance", stage: "publish-note" }, projectRoot: fx.project, source: { runId: "run-conformance", stageId: "publish-note", attempt: 1 } },
          body,
        ),
    });
  }

  function agentTool() {
    return createAgentPublishArtifactTool({
      agentId: "arts",
      projectRoot: fx.project,
      stageflowHome: fx.home,
      publish: (body) =>
        publishSessionArtifact(
          { db: fx.connection, roots: roots() },
          { owner: { kind: "agent", agent: "arts" }, projectRoot: fx.project, source: { sessionId: "ses_conformance_publish" } },
          body,
        ),
    });
  }

  for (const testCase of PUBLISH_CASES) {
    it(`${testCase.name} -> ${testCase.verdict} on both stage and agent`, async () => {
      const id = `conf-${seq++}`;
      const verdicts = [];
      for (const tool of [stageTool(), agentTool()]) {
        const result = await tool.execute("call", { id, ...testCase.params });
        const details = result.details as { code?: string; warnings?: unknown[] };
        verdicts.push({ verdict: result.isError ? details.code : "ok", warns: (details.warnings?.length ?? 0) > 0 });
      }
      expect(verdicts[0], JSON.stringify(verdicts)).toEqual({ verdict: testCase.verdict, warns: testCase.warns === true });
      expect(verdicts[1]).toEqual(verdicts[0]);
    });
  }
});
