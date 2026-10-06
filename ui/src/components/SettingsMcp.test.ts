import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function readUi(rel: string): string {
  return readFileSync(path.join(here, rel), "utf8");
}

describe("SettingsMcp operator-host copy", () => {
  const mcp = readUi("./SettingsMcp.tsx");

  it("does not claim MCP cannot submit an answer", () => {
    expect(mcp).not.toMatch(/cannot submit an answer/);
    expect(mcp).toMatch(/answer_gate/);
    expect(mcp).toMatch(/wait_run/);
    expect(mcp).toMatch(/decide_feedback_loop/);
    expect(mcp).toMatch(/list_providers/);
    expect(mcp).toMatch(/list_models/);
    expect(mcp).toMatch(/list_project_mcp/);
    expect(mcp).toMatch(/probe_project_mcp/);
    expect(mcp).toMatch(/describe_pipeline/);
    expect(mcp).toMatch(/validate/);
    expect(mcp).not.toMatch(/retry_stage/);
    expect(mcp).not.toMatch(/resume_stage/);
    expect(mcp).not.toMatch(/abandon_stage/);
    expect(mcp).not.toMatch(/recover_manual_stage/);
    expect(mcp).not.toMatch(/stop_manual_recovery/);
    expect(mcp).not.toMatch(/"rerun"/);
  });
});
