import { describe, expect, it } from "vitest";
import { agentsRouteProps, railActiveId } from "./routeNav";
import type { Route } from "./routes";

describe("railActiveId", () => {
  it("lights the rail item a route belongs to", () => {
    const cases: Array<[Route, string]> = [
      [{ name: "detail", runId: "r", view: "stream" } as unknown as Route, "runs"],
      [{ name: "new" }, "inbox"],
      [{ name: "pipeline", pipelineId: "p" }, "pipelines"],
      [{ name: "workshop" }, "pipelines"],
      [{ name: "task", taskId: "t" }, "tasks"],
      [{ name: "connection", connectionId: "c" }, "connections"],
      [{ name: "connect" }, "settings"],
      [{ name: "agentSessions" }, "agent-sessions"],
      [{ name: "settings" }, "settings"],
      [{ name: "triggers" }, "triggers"],
    ];
    for (const [route, id] of cases) expect(railActiveId(route, true)).toBe(id);
  });

  it("keeps every agent route under Agents, create included", () => {
    const routes: Route[] = [
      { name: "agents" },
      { name: "agentCreate" },
      { name: "agent", agentId: "a", screen: "edit" },
      { name: "agentSession", agentId: "a", sessionId: "s" },
      { name: "agentRun", agentId: "a", sessionId: "s", runId: "1" },
    ];
    for (const route of routes) expect(railActiveId(route, true)).toBe("agents");
  });

  it("folds skills and extensions into Catalog only when the redesign is on", () => {
    const skill: Route = { name: "skill", skillName: "x" };
    const pkg: Route = { name: "extensionPackage", scope: "user", source: "s" };
    expect(railActiveId(skill, true)).toBe("catalog");
    expect(railActiveId({ name: "stage", path: "p" }, true)).toBe("catalog");
    expect(railActiveId(pkg, true)).toBe("catalog");
    expect(railActiveId(skill, false)).toBe("skills");
    expect(railActiveId(pkg, false)).toBe("extensions");
    expect(railActiveId({ name: "skills" }, false)).toBe("skills");
  });
});

describe("agentsRouteProps", () => {
  it("maps each agent route to a screen", () => {
    expect(agentsRouteProps({ name: "agents" })).toEqual({ screen: "directory" });
    expect(agentsRouteProps({ name: "agentCreate" })).toEqual({ screen: "create" });
    expect(agentsRouteProps({ name: "agent", agentId: "a", screen: "detail" })).toEqual({ screen: "detail", agentId: "a" });
    expect(agentsRouteProps({ name: "agent", agentId: "a", screen: "edit" })).toEqual({ screen: "edit", agentId: "a" });
    expect(agentsRouteProps({ name: "agentSession", agentId: "a", sessionId: "s" })).toEqual({ screen: "session", agentId: "a", sessionId: "s" });
    expect(agentsRouteProps({ name: "agentRun", agentId: "a", sessionId: "s", runId: "2" })).toEqual({
      screen: "run",
      agentId: "a",
      sessionId: "s",
      runId: "2",
    });
  });
  it("leaves the sessions list and other routes alone", () => {
    expect(agentsRouteProps({ name: "agentSessions" })).toBeNull();
    expect(agentsRouteProps({ name: "settings" })).toBeNull();
  });
});
