import { describe, expect, it } from "vitest";
import { AgentApiError } from "../../../api/agents";
import { MISSING_COPY, initialResource, missingKind, resourceReducer, type ResourceState } from "./resourceState";

const loaded = (key: string, data: string): ResourceState<string> =>
  resourceReducer(initialResource<string>(key), { type: "ok", key, data, at: 1 });

describe("resourceReducer", () => {
  it("starts loading with no data, and a null key is idle", () => {
    expect(initialResource("a")).toMatchObject({ data: null, loading: true });
    expect(initialResource(null)).toMatchObject({ data: null, loading: false });
  });

  it("stores a result for the current key", () => {
    expect(loaded("a", "x")).toMatchObject({ data: "x", loading: false, error: null, updatedAt: 1 });
  });

  it("clears data when the key changes", () => {
    const next = resourceReducer(loaded("a", "x"), { type: "start", key: "b" });
    expect(next).toMatchObject({ key: "b", data: null, loading: true });
  });

  it("drops a late result for an old key", () => {
    const state = resourceReducer(loaded("a", "x"), { type: "start", key: "b" });
    expect(resourceReducer(state, { type: "ok", key: "a", data: "old", at: 2 })).toBe(state);
    expect(resourceReducer(state, { type: "fail", key: "a", error: new Error("old") })).toBe(state);
  });

  it("a reload keeps the data, a silent poll start changes nothing", () => {
    const state = loaded("a", "x");
    expect(resourceReducer(state, { type: "start", key: "a" })).toMatchObject({ data: "x", loading: true });
    expect(resourceReducer(state, { type: "start", key: "a", silent: true })).toBe(state);
  });

  it("a failure keeps earlier data and records the error; the next success clears it", () => {
    const failed = resourceReducer(loaded("a", "x"), { type: "fail", key: "a", error: new Error("down") });
    expect(failed).toMatchObject({ data: "x", loading: false });
    expect(failed.error?.message).toBe("down");
    expect(resourceReducer(failed, { type: "ok", key: "a", data: "y", at: 3 })).toMatchObject({ data: "y", error: null });
  });

  it("set replaces data like a result", () => {
    expect(resourceReducer(loaded("a", "x"), { type: "set", key: "a", data: "z", at: 4 }).data).toBe("z");
  });
});

describe("missingKind", () => {
  it("maps a 404 to the kind being loaded", () => {
    const notFound = new AgentApiError("not_found", 404, "nope");
    expect(missingKind(notFound, "agent")).toBe("agent");
    expect(missingKind(notFound, "session")).toBe("session");
    expect(missingKind(notFound, "run")).toBe("run");
  });
  it("is null for other errors and for no error", () => {
    expect(missingKind(new AgentApiError("boom", 500, "x"), "agent")).toBeNull();
    expect(missingKind(new Error("network"), "session")).toBeNull();
    expect(missingKind(null, "agent")).toBeNull();
  });
  it("only the agent copy says 'Agent'", () => {
    expect(MISSING_COPY.agent.title).toBe("Agent not found");
    expect(MISSING_COPY.session.title).not.toMatch(/agent/i);
    expect(MISSING_COPY.run.title).not.toMatch(/agent/i);
  });
});
