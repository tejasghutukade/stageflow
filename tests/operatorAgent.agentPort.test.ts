import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSHOP_AUTHOR_PROFILE_ID } from "../src/operatorAgent/profiles/workshopAuthor.js";
import {
  AGENT_PORT_BACKENDS,
  createPiAgentPort,
  resolveAgentPort,
} from "../src/operatorAgent/agentPort.js";

describe("resolveAgentPort", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "sf-agent-port-"));

  it("defaults to the Pi agent port and registers Workshop Author", () => {
    expect(AGENT_PORT_BACKENDS).toEqual(["pi"]);
    const port = resolveAgentPort({ cwd, projectRoot: cwd });
    expect(port.listProfiles().map((profile) => profile.id)).toEqual([
      WORKSHOP_AUTHOR_PROFILE_ID,
    ]);
    expect(
      createPiAgentPort({ cwd, projectRoot: cwd }).listProfiles().map((profile) => profile.id),
    ).toEqual([WORKSHOP_AUTHOR_PROFILE_ID]);
  });

  it("selects Pi when the backend is set", () => {
    const port = resolveAgentPort({ cwd, projectRoot: cwd, backend: "pi" });
    expect(port.listProfiles().map((profile) => profile.id)).toEqual([
      WORKSHOP_AUTHOR_PROFILE_ID,
    ]);
  });
});
