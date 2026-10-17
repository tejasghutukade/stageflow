import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forbiddenWriteTarget } from "../src/agents/policy.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const project = "/work/project";
const home = "/home/.stageflow";
const def = path.join(project, "agents", "lead.agent.yaml");

describe("path protection for tool calls", () => {
  it("covers write, edit and any other tool that names a path", () => {
    expect(forbiddenWriteTarget(project, home, "write", { path: def })).toBe(def);
    expect(forbiddenWriteTarget(project, home, "edit", { file_path: "agents/lead.agent.yaml" })).toBe("agents/lead.agent.yaml");
    expect(forbiddenWriteTarget(project, home, "fs_write_file", { filePath: def })).toBe(def);
    expect(forbiddenWriteTarget(project, home, "files.move", { source: "a.txt", destination: def })).toBe(def);
    expect(forbiddenWriteTarget(project, home, "files.multi", { paths: ["ok.txt", path.join(home, "state.db")] })).toBe(path.join(home, "state.db"));
  });

  it("leaves reads and ordinary paths alone", () => {
    expect(forbiddenWriteTarget(project, home, "read", { path: def })).toBeUndefined();
    expect(forbiddenWriteTarget(project, home, "grep", { path: def })).toBeUndefined();
    expect(forbiddenWriteTarget(project, home, "write", { path: path.join(project, "notes.md") })).toBeUndefined();
    expect(forbiddenWriteTarget(project, home, "bash", { command: `rm ${def}` })).toBeUndefined();
  });

  it("warns that bash is not path-confined", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const withShell = await fixture.service.validate(fixture.project, agentInput("shelly", { tools: { builtin: ["shell"] } }));
    expect(withShell.warnings.map((w) => w.code)).toContain("agent.shell_not_path_confined");
    const single = await fixture.service.validate(fixture.project, agentInput("shelly", { tools: { builtin_tools: ["bash"] } }));
    expect(single.warnings.map((w) => w.code)).toContain("agent.shell_not_path_confined");
    const readOnly = await fixture.service.validate(fixture.project, agentInput("shelly", { tools: { builtin: ["read"] } }));
    expect(readOnly.warnings.map((w) => w.code)).not.toContain("agent.shell_not_path_confined");
  });
});
