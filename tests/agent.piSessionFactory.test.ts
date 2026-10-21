import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkshopToolsExcludeDiskShell,
  createPiAgentSession,
  createSealedResourceLoader,
  resolveWorkshopToolNames,
  WORKSHOP_FORBIDDEN_BUILTIN_TOOLS,
} from "../src/agent/piSessionFactory.js";
import { resolveStageToolNames } from "../src/agent/piAdapter.js";

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: piSdkMocks.createAgentSession,
  };
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-pi-session-factory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  piSdkMocks.createAgentSession.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("createPiAgentSession", () => {
  it("returns a session with prompt when given minimal fakes", async () => {
    const prompt = vi.fn(async () => undefined);
    piSdkMocks.createAgentSession.mockResolvedValue({
      session: { prompt, bindExtensions: vi.fn(), dispose: vi.fn() },
      extensionsResult: { extensions: [], errors: [], tools: new Map() },
    });

    const root = await makeTempDir();
    const cwd = path.join(root, "cwd");
    const agentDir = path.join(root, "agent");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const loader = createSealedResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPrompt: "workshop",
    });
    await loader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    const modelRuntime = await ModelRuntime.create();

    const { session } = await createPiAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      tools: ["read_draft", "validate_draft"],
      customTools: [],
    });

    expect(typeof session.prompt).toBe("function");
    await session.prompt("hello");
    expect(prompt).toHaveBeenCalledWith("hello");

    const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as {
      cwd: string;
      agentDir: string;
      tools: string[];
      customTools: unknown[];
      resourceLoader: unknown;
      sessionManager: unknown;
      settingsManager: unknown;
      modelRuntime: unknown;
    };
    expect(options.cwd).toBe(cwd);
    expect(options.agentDir).toBe(agentDir);
    expect(options.tools).toEqual(["read_draft", "validate_draft"]);
    expect(options.customTools).toEqual([]);
    expect(options.resourceLoader).toBe(loader);
    expect(options.sessionManager).toBe(sessionManager);
    expect(options.settingsManager).toBe(settingsManager);
    expect(options.modelRuntime).toBe(modelRuntime);
  });
});

describe("Workshop tool allowlist", () => {
  it("excludes bash, write, and edit", () => {
    expect(WORKSHOP_FORBIDDEN_BUILTIN_TOOLS).toEqual(["bash", "write", "edit"]);
    expect(() =>
      assertWorkshopToolsExcludeDiskShell(["read_draft", "create_stage"]),
    ).not.toThrow();
    expect(resolveWorkshopToolNames(["read_draft", "save"])).toEqual([
      "read_draft",
      "save",
    ]);
  });

  it("rejects allowlists that include disk/shell builtins", () => {
    expect(() =>
      assertWorkshopToolsExcludeDiskShell(["read_draft", "bash"]),
    ).toThrow(/bash/);
    expect(() => resolveWorkshopToolNames(["write", "edit"])).toThrow(
      /write.*edit|edit.*write/,
    );
  });

  it("is not resolveStageToolNames (stage builtins stay off Workshop path)", () => {
    const stageTools = resolveStageToolNames("emit_stage_envelope");
    for (const name of WORKSHOP_FORBIDDEN_BUILTIN_TOOLS) {
      expect(stageTools).toContain(name);
    }
    expect(() => assertWorkshopToolsExcludeDiskShell(stageTools)).toThrow(
      /disk\/shell builtins/,
    );
  });
});
