import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  loginWithApiKey,
  makeMutationLock,
  type ProviderAuthRuntime,
} from "../src/agent/providerAuth.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  createLiveWorkshopOperatorHost,
  sessionNeedsExtensionReload,
  workshopToolActivity,
  workshopToolLogFields,
  type PiOperatorOpenSessionInput,
  type PiOperatorSessionHandle,
} from "../src/operatorAgent/piModel.js";
import {
  createWorkshopDraftContext,
  emptyDraftPackage,
  readDraftFromContext,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "../src/operatorAgent/index.js";
import { resolveWorkshopToolNames } from "../src/agent/piSessionFactory.js";
import { registerProviderSupport } from "../src/agent/providerSupport.js";
import { WORKSHOP_AUTHOR_TOOL_NAMES } from "../src/operatorAgent/profiles/workshopAuthor.js";

const tempHandles: PiOperatorSessionHandle[] = [];

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";
const USABLE_AUTH = `${JSON.stringify({
  openai: { type: "api_key", key: "sk-operator" },
})}\n`;
const AUTHOR_MODEL = "anthropic/claude-sonnet-4-5";

type AuthFileState = "missing" | "blank" | "{}";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withSplitRoots<T>(
  fn: (roots: { data: string; creds: string; cwd: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-pi-home-"));
  const data = await mkdtemp(path.join(tmpdir(), "sf-pi-data-"));
  const creds = await mkdtemp(path.join(tmpdir(), "sf-pi-cred-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "sf-pi-cwd-"));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
    credentialHome: process.env[CREDENTIAL_HOME_ENV],
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.STAGEFLOW_HOME = data;
  process.env[CREDENTIAL_HOME_ENV] = creds;
  resetGlobalStageflowHomeForTests();
  try {
    return await fn({ data, creds, cwd });
  } finally {
    restoreEnv("HOME", prev.HOME);
    restoreEnv("USERPROFILE", prev.USERPROFILE);
    restoreEnv("STAGEFLOW_HOME", prev.STAGEFLOW_HOME);
    restoreEnv(CREDENTIAL_HOME_ENV, prev.credentialHome);
    resetGlobalStageflowHomeForTests();
    await rm(home, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
    await rm(creds, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeAuthState(
  authPath: string,
  state: AuthFileState,
): Promise<void> {
  if (state === "missing") return;
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, state === "blank" ? " \n" : "{}\n");
}

function authorHost(
  cwd: string,
  agentDir: string,
  openPiSession?: (
    input: PiOperatorOpenSessionInput,
  ) => Promise<PiOperatorSessionHandle>,
) {
  return createLiveWorkshopOperatorHost({
    cwd,
    agentDir,
    ...(openPiSession !== undefined ? { openPiSession } : {}),
    model: AUTHOR_MODEL,
    settingsDefault: "openai/gpt-4.1",
    profileDefault: "cursor/auto",
  });
}

async function authorError(
  cwd: string,
  agentDir: string,
): Promise<string> {
  const host = authorHost(cwd, agentDir);
  const session = host.openSession({
    profileId: WORKSHOP_AUTHOR_PROFILE_ID,
    context: createWorkshopDraftContext(emptyDraftPackage("demo")),
  });
  try {
    const events = await session.send("hello");
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type !== "error") {
      throw new Error("expected an author error event");
    }
    return error.message;
  } finally {
    session.close();
  }
}

function loginRuntime(): ProviderAuthRuntime {
  const store = new Map<string, "api_key" | "oauth">();
  const provider = {
    id: "key-provider",
    name: "Key Provider",
    auth: {
      apiKey: {
        login: async () => ({ type: "api_key" as const, key: "stored" }),
      },
    },
  } as unknown as Provider;
  return {
    getProviders: () => [provider],
    getProvider: (id) => (id === provider.id ? provider : undefined),
    getProviderAuthStatus: (id) => ({
      configured: store.has(id),
      source: store.has(id) ? "stored" : undefined,
    }),
    listCredentials: async () =>
      [...store.entries()].map(([providerId, type]) => ({ providerId, type })),
    checkAuth: async () => undefined,
    login: async (providerId, type) => {
      store.set(providerId, type);
    },
    logout: async (providerId) => {
      store.delete(providerId);
    },
  };
}

afterEach(async () => {
  while (tempHandles.length > 0) {
    const handle = tempHandles.pop();
    if (handle) await handle.shutdown();
  }
});

function createMockPiHandle(
  onPrompt?: (text: string, input: PiOperatorOpenSessionInput) => Promise<void> | void,
): {
  handle: PiOperatorSessionHandle;
  getOpened: () => PiOperatorOpenSessionInput | undefined;
  openPiSession: (
    input: PiOperatorOpenSessionInput,
  ) => Promise<PiOperatorSessionHandle>;
} {
  let opened: PiOperatorOpenSessionInput | undefined;
  const listeners = new Set<(event: unknown) => void>();
  const appendCustomMessageEntry = vi.fn();
  const handle: PiOperatorSessionHandle = {
    session: {
      prompt: vi.fn(async (text: string) => {
        if (opened) await onPrompt?.(text, opened);
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Done.",
            },
          });
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
            },
          });
        }
      }),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      dispose: vi.fn(),
      bindExtensions: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      agent: { state: { messages: [] } },
    },
    sessionManager: {
      appendCustomMessageEntry,
      buildSessionContext: vi.fn(() => ({ messages: [] })),
      getSessionId: vi.fn(() => "pi-mock-session"),
    },
    piSessionId: "pi-mock-session",
    shutdown: vi.fn(async () => undefined),
  };
  tempHandles.push(handle);
  return {
    handle,
    getOpened: () => opened,
    openPiSession: async (input) => {
      opened = input;
      return handle;
    },
  };
}

describe("createPiOperatorAgentModel", () => {
  it("mocked Pi tool call mutates the draft via host handlers", async () => {
    const mock = createMockPiHandle(async (_text, input) => {
      expect(input.toolNames).toEqual(
        resolveWorkshopToolNames([...WORKSHOP_AUTHOR_TOOL_NAMES]),
      );
      expect(input.toolNames).not.toContain("bash");
      expect(input.toolNames).not.toContain("write");
      expect(input.toolNames).not.toContain("edit");
      const createStage = input.customTools.find((t) => t.name === "create_stage");
      expect(createStage).toBeDefined();
      await createStage!.execute!("call-1", {
        id: "intake",
        system_prompt: "Collect intake",
        summary: "intake form",
      });
    });

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("add intake stage");
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "proposal")).toBe(true);
    expect(events.some((e) => e.type === "message")).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages.map((s) => s.id)).toEqual(["intake"]);
    expect(mock.getOpened()?.systemPrompt.length).toBeGreaterThan(0);

    session.close();
  });

  it("opens Pi on the composer model and switches it before a later turn", async () => {
    const applied: string[] = [];
    const mock = createMockPiHandle();
    mock.handle.applyModel = vi.fn(async (modelId: string) => {
      applied.push(modelId);
    });
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("first", { modelId: "cursor/auto" });
    expect(mock.getOpened()?.modelId).toBe("cursor/auto");
    expect(applied).toEqual([]);

    await session.send("second", { modelId: "cursor/composer-2-5" });
    expect(applied).toEqual(["cursor/composer-2-5"]);

    session.close();
  });

  it("replay path seeds transcript without throwing", async () => {
    const mock = createMockPiHandle();
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await expect(
      session.prepareRestart?.([
        { role: "user", text: "Build a release pipeline" },
        { role: "assistant", text: "What stages do you need?" },
      ]),
    ).resolves.toBeUndefined();

    expect(
      mock.handle.sessionManager.appendCustomMessageEntry,
    ).toHaveBeenCalledWith(
      "stageflow.workshop_transcript_replay",
      expect.stringContaining("Build a release pipeline"),
      true,
      { messageCount: 2 },
    );

    session.close();
  });

  it("forwards Pi text_delta to onDelta mid-prompt before complete resolves", async () => {
    const deltas: string[] = [];
    let promptFinished = false;
    const listeners = new Set<(event: unknown) => void>();
    const multiHandle: PiOperatorSessionHandle = {
      session: {
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "Hi " },
            });
          }
          await new Promise((r) => setTimeout(r, 10));
          expect(promptFinished).toBe(false);
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "there" },
            });
          }
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Hi there" }],
              },
            });
          }
          promptFinished = true;
        }),
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        dispose: vi.fn(),
        bindExtensions: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        agent: { state: { messages: [] } },
      },
      sessionManager: {
        appendCustomMessageEntry: vi.fn(),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getSessionId: vi.fn(() => "pi-stream-session"),
      },
      piSessionId: "pi-stream-session",
      shutdown: vi.fn(async () => undefined),
    };
    tempHandles.push(multiHandle);

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: async () => multiHandle,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("hello", {
      onDelta: (text) => {
        expect(promptFinished).toBe(false);
        deltas.push(text);
      },
    });
    expect(deltas).toEqual(["Hi ", "there"]);
    expect(events.some((e) => e.type === "message")).toBe(true);
    const msg = events.find((e) => e.type === "message");
    if (msg?.type === "message") {
      expect(msg.text).toBe("Hi there");
    }
    session.close();
  });

  it("abort calls the Pi session abort while a prompt is in flight", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let promptStarted!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const listeners = new Set<(event: unknown) => void>();
    const abort = vi.fn(async () => {
      releasePrompt();
    });
    const handle: PiOperatorSessionHandle = {
      session: {
        prompt: vi.fn(async () => {
          promptStarted();
          await promptGate;
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Stopped." }],
              },
            });
          }
        }),
        abort,
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        dispose: vi.fn(),
        bindExtensions: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        agent: { state: { messages: [] } },
      },
      sessionManager: {
        appendCustomMessageEntry: vi.fn(),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getSessionId: vi.fn(() => "pi-abort-session"),
      },
      piSessionId: "pi-abort-session",
      shutdown: vi.fn(async () => undefined),
    };
    tempHandles.push(handle);

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: async () => handle,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });
    const sendPromise = session.send("hello");
    await promptEntered;
    await session.abort();
    const events = await sendPromise;
    expect(abort).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "message")).toBe(true);
    session.close();
  });

  it("missing auth surfaces a clear actionable error", async () => {
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      authPath: "/tmp/stageflow-missing-workshop-auth.json",
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("hello");
    const error = events.find((e) => e.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.message).toMatch(/provider auth is not configured/i);
      expect(error.message).toMatch(/sf providers/i);
    }

    session.close();
  });

  it("a provider-backed model (its own login, e.g. Cursor) does not need the Pi auth file", async () => {
    registerProviderSupport({
      id: "workshop-own-login",
      matches: (ref) => ref === "own-login/model",
      prepare: () => ({ extensionPaths: [], error: "provider prepared without auth.json" }),
    });
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      authPath: "/tmp/stageflow-missing-workshop-auth.json",
      resolveModelId: () => "own-login/model",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("hello");
    const error = events.find((e) => e.type === "error");
    // The auth-file gate is skipped; the provider's own prepare step runs instead.
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.message).not.toMatch(/provider auth is not configured/i);
      expect(error.message).toMatch(/provider prepared without auth\.json/);
    }
    session.close();
  });

  it("concurrent chat turns keep profile/tools/events isolated per binding", async () => {
    let openSeq = 0;
    const openPiSession = async (
      input: PiOperatorOpenSessionInput,
    ): Promise<PiOperatorSessionHandle> => {
      openSeq += 1;
      const openIndex = openSeq;
      const listeners = new Set<(event: unknown) => void>();
      const handle: PiOperatorSessionHandle = {
        session: {
          prompt: vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20));
            const createStage = input.customTools.find(
              (t) => t.name === "create_stage",
            );
            expect(createStage).toBeDefined();
            await createStage!.execute!("call-1", {
              id: `stage-${openIndex}`,
              summary: `from open ${openIndex}`,
            });
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: "ok",
                },
              });
              listener({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                },
              });
            }
          }),
          subscribe: vi.fn((listener: (event: unknown) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }),
          dispose: vi.fn(),
          bindExtensions: vi.fn(async () => undefined),
          setModel: vi.fn(async () => undefined),
          setThinkingLevel: vi.fn(),
          agent: { state: { messages: [] } },
        },
        sessionManager: {
          appendCustomMessageEntry: vi.fn(),
          buildSessionContext: vi.fn(() => ({ messages: [] })),
          getSessionId: vi.fn(() => `pi-${openIndex}`),
        },
        piSessionId: `pi-${openIndex}`,
        shutdown: vi.fn(async () => undefined),
      };
      tempHandles.push(handle);
      return handle;
    };

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const sessionA = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("alpha")),
    });
    const sessionB = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("beta")),
    });

    const [eventsA, eventsB] = await Promise.all([
      sessionA.send("mutate A"),
      sessionB.send("mutate B"),
    ]);

    expect(eventsA.some((e) => e.type === "tool_result")).toBe(true);
    expect(eventsB.some((e) => e.type === "tool_result")).toBe(true);

    const draftA = readDraftFromContext(sessionA.getContext());
    const draftB = readDraftFromContext(sessionB.getContext());
    expect(draftA.pipeline.id).toBe("alpha");
    expect(draftB.pipeline.id).toBe("beta");
    expect(draftA.pipeline.stages).toHaveLength(1);
    expect(draftB.pipeline.stages).toHaveLength(1);
    expect(draftA.pipeline.stages[0]!.id).not.toBe(draftB.pipeline.stages[0]!.id);
    expect(draftA.stages).toHaveLength(1);
    expect(draftB.stages).toHaveLength(1);

    sessionA.close();
    sessionB.close();
  });

  it("appends the cursor pi__ tool hint only for cursor models", async () => {
    let prompted = "";
    const mock = createMockPiHandle(async (text) => {
      prompted = text;
    });
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("make a research stage", { modelId: "cursor/auto" });
    expect(prompted).toContain("make a research stage");
    expect(prompted).toContain("pi__create_stage");
    expect(mock.getOpened()?.modelId).toBe("cursor/auto");

    await session.send("make a research stage", {
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(prompted).toBe("make a research stage");
    session.close();
  });

  it("logs a string stage body as ignored; successful tools stay complete", () => {
    const args = { id: "research", body: "system_prompt: hello" };
    expect(workshopToolLogFields(args).bodyIgnored).toBe(true);
    expect(workshopToolLogFields(args).bodyType).toBe("string");
    expect(
      workshopToolActivity("call-1", "create_stage", "done", args, {
        ok: true,
        content: null,
      }),
    ).toMatchObject({
      id: "call-1",
      name: "create_stage",
      status: "complete",
      target: "research",
    });
    expect(
      workshopToolActivity("call-2", "create_stage", "done", { id: "research" }, {
        ok: false,
        content: null,
        error: "id is required",
      }),
    ).toMatchObject({
      status: "error",
      errorMessage: "id is required",
    });
  });

  it("reopens a Pi session when the selected model needs an extension that is not loaded", () => {
    expect(sessionNeedsExtensionReload(undefined, ["/ext/index.js"])).toBe(false);
    expect(sessionNeedsExtensionReload([], ["/ext/index.js"])).toBe(true);
    expect(sessionNeedsExtensionReload(["/ext/index.js"], ["/ext/index.js"])).toBe(false);
    expect(sessionNeedsExtensionReload(["/ext/index.js"], [])).toBe(false);
  });

  it("opens a model session from a usable operator auth file when the process file is {}", async () => {
    await withSplitRoots(async ({ data, creds, cwd }) => {
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const dataAuth = path.join(data, "agent", "auth.json");
      await mkdir(path.dirname(operatorAuth), { recursive: true });
      await mkdir(path.dirname(dataAuth), { recursive: true });
      await writeFile(operatorAuth, USABLE_AUTH);
      await writeFile(dataAuth, "{}\n");
      const agentDir = path.join(data, "workshop-agent");

      const create = vi
        .spyOn(ModelRuntime, "create")
        .mockRejectedValue(new Error("model-session-opened"));
      try {
        const message = await authorError(cwd, agentDir);
        expect(message).toBe("model-session-opened");
        expect(create).toHaveBeenCalledWith({
          authPath: operatorAuth,
          modelsPath: path.join(creds, "agent", "models.json"),
        });
      } finally {
        create.mockRestore();
      }

      const mock = createMockPiHandle();
      const host = authorHost(cwd, agentDir, mock.openPiSession);
      const session = host.openSession({
        profileId: WORKSHOP_AUTHOR_PROFILE_ID,
        context: createWorkshopDraftContext(emptyDraftPackage("demo")),
      });
      const events = await session.send("hello");
      expect(events.some((event) => event.type === "message")).toBe(true);
      expect(mock.getOpened()?.authPath).toBe(operatorAuth);
      expect(mock.getOpened()?.modelId).toBe(AUTHOR_MODEL);
      expect(await readFile(operatorAuth, "utf8")).toBe(USABLE_AUTH);
      expect(await readFile(dataAuth, "utf8")).toBe("{}\n");
      session.close();
    });
  });

  it("does not create a missing operator auth file when Author opens", async () => {
    await withSplitRoots(async ({ data, creds, cwd }) => {
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const create = vi.spyOn(ModelRuntime, "create");
      try {
        const message = await authorError(cwd, path.join(data, "workshop-agent"));
        expect(message).toMatch(/provider auth is not configured/i);
        expect(message).toContain(operatorAuth);
        expect(message).toMatch(/sf providers/i);
        expect(existsSync(operatorAuth)).toBe(false);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
    });
  });

  it("fails Author before the model call for a blank or empty operator auth file", async () => {
    for (const state of ["blank", "{}"] as const) {
      await withSplitRoots(async ({ data, creds, cwd }) => {
        const operatorAuth = path.join(creds, "agent", "auth.json");
        await writeAuthState(operatorAuth, state);
        const create = vi.spyOn(ModelRuntime, "create");
        try {
          const message = await authorError(
            cwd,
            path.join(data, "workshop-agent"),
          );
          expect(message).toMatch(/provider auth is not configured/i);
          expect(message).toContain(operatorAuth);
          expect(message).not.toMatch(/is not used/);
          expect(create).not.toHaveBeenCalled();
        } finally {
          create.mockRestore();
        }
      });
    }
  });

  it("names the unused data-directory auth file when the operator file is unusable", async () => {
    for (const state of ["missing", "blank", "{}"] as const) {
      await withSplitRoots(async ({ data, creds, cwd }) => {
        const operatorAuth = path.join(creds, "agent", "auth.json");
        const dataAuth = path.join(data, "agent", "auth.json");
        await mkdir(path.dirname(dataAuth), { recursive: true });
        await writeFile(dataAuth, USABLE_AUTH);
        await writeAuthState(operatorAuth, state);
        const create = vi.spyOn(ModelRuntime, "create");
        try {
          const message = await authorError(
            cwd,
            path.join(data, "workshop-agent"),
          );
          expect(message).toContain(operatorAuth);
          expect(message).toContain(dataAuth);
          expect(message).toMatch(/process data directory/i);
          expect(message).toMatch(/is not used/i);
          expect(create).not.toHaveBeenCalled();
          if (state === "missing") {
            expect(existsSync(operatorAuth)).toBe(false);
          }
          expect(await readFile(dataAuth, "utf8")).toBe(USABLE_AUTH);
        } finally {
          create.mockRestore();
        }
      });
    }
  });

  it("login creates a missing operator auth file and a later Author open uses it", async () => {
    await withSplitRoots(async ({ data, creds, cwd }) => {
      const operatorAuth = path.join(creds, "agent", "auth.json");
      const dataAuth = path.join(data, "agent", "auth.json");
      expect(existsSync(operatorAuth)).toBe(false);

      await loginWithApiKey(cwd, "key-provider", "sk-test-secret-marker-U4", {
        lock: makeMutationLock(),
        createRuntime: async (authPath) => {
          expect(authPath).toBe(operatorAuth);
          await mkdir(path.dirname(authPath), { recursive: true });
          await writeFile(authPath, USABLE_AUTH);
          return loginRuntime();
        },
      });
      expect(await readFile(operatorAuth, "utf8")).toBe(USABLE_AUTH);
      expect(existsSync(dataAuth)).toBe(false);

      const agentDir = path.join(data, "workshop-agent");
      const create = vi
        .spyOn(ModelRuntime, "create")
        .mockRejectedValue(new Error("model-session-opened"));
      try {
        const message = await authorError(cwd, agentDir);
        expect(message).toBe("model-session-opened");
        expect(create).toHaveBeenCalledWith({
          authPath: operatorAuth,
          modelsPath: path.join(path.dirname(operatorAuth), "models.json"),
        });
      } finally {
        create.mockRestore();
      }

      const mock = createMockPiHandle();
      const host = authorHost(cwd, agentDir, mock.openPiSession);
      const session = host.openSession({
        profileId: WORKSHOP_AUTHOR_PROFILE_ID,
        context: createWorkshopDraftContext(emptyDraftPackage("demo")),
      });
      const events = await session.send("hello");
      expect(events.some((event) => event.type === "message")).toBe(true);
      expect(mock.getOpened()?.authPath).toBe(operatorAuth);
      expect(mock.getOpened()?.modelId).toBe(AUTHOR_MODEL);
      session.close();
    });
  });
});
