import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runAgentsCommand } from "../src/cli/agentsCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function host() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-cli-agents-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-cli-agents-project-"));
  dirs.push(home, project);
  await mkdir(path.join(project, "agents"));
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    agentConversationBackend: scriptedBackend((messages) => `reply to ${messages.at(-1)!.text}`),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = (...args: string[]) =>
    runAgentsCommand(args, {
      projectRoot: project,
      cwd: project,
      hostBaseUrl: `http://127.0.0.1:${address.port}`,
      ensureService: async () => ({ ok: true }) as never,
      io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line), write: (chunk) => stdout.push(chunk) },
    });
  return { project, run, stdout, stderr };
}

describe("sf agents", () => {
  it("validates a file, then lists, enables, chats, and shows history through the Host", async () => {
    const { project, run, stdout, stderr } = await host();
    await writeFile(path.join(project, "draft.yaml"), "id: helper\nname: Helper\n");
    expect(await run("validate", "draft.yaml")).toBe(1);
    expect(stderr.join("\n")).toContain("instructions: Required");

    await writeFile(path.join(project, "agents", "helper.agent.yaml"), "id: helper\nname: Helper\ninstructions: Help.\n");
    stdout.length = 0;
    expect(await run("list")).toBe(0);
    expect(stdout).toEqual(["helper\tv1\tdisabled\tHelper"]);

    expect(await run("chat", "helper", "--message", "hi")).toBe(1);
    expect(stderr.at(-1)).toBe("agent.disabled");

    expect(await run("enable", "helper")).toBe(0);
    stdout.length = 0;
    expect(await run("chat", "helper", "--message", "hi")).toBe(0);
    expect(stdout.join("")).toBe("reply to hi\n");

    stdout.length = 0;
    expect(await run("history", "helper", "--json")).toBe(0);
    const history = JSON.parse(stdout.join("\n")) as { revisions: Array<{ revision: number; source: string }> };
    expect(history.revisions.map((row) => [row.revision, row.source])).toEqual([
      [2, "console"],
      [1, "file"],
    ]);
  });

  it("prints usage for bad arguments", async () => {
    const { run, stderr } = await host();
    expect(await run("restore", "helper")).toBe(1);
    expect(stderr.join("\n")).toContain("restore needs <id> <revision>");
  });
});
