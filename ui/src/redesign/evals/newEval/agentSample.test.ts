import { afterEach, describe, expect, it, vi } from "vitest";
import { installEvalSample } from "../../../api/evalsClient";
import { agentSampleAvailability, agentSampleError } from "./wizardModel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent sample", () => {
  it("is offered; the server decides if it fits", () => {
    expect(agentSampleAvailability()).toEqual({ ok: true });
  });

  it("explains the two server codes", () => {
    expect(agentSampleError("SAMPLE_NO_DEFAULT_MODEL", "x")).toContain("default model");
    expect(agentSampleError("SAMPLE_AGENTS_UNAVAILABLE", "x")).toContain("cannot create agents");
    expect(agentSampleError("SAMPLE_EXISTS", "x")).toContain("already installed");
    expect(agentSampleError("OTHER", "raw message")).toBe("raw message");
  });

  it("posts kind: agent only for the agent sample", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return { status: 201, ok: true, json: async () => ({ eval_id: "support-sample" }) } as Response;
      }),
    );
    await installEvalSample();
    await installEvalSample("/p", "agent");
    expect(bodies).toEqual([{}, { project_root: "/p", kind: "agent" }]);
  });
});
