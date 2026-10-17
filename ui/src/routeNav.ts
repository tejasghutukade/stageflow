import type { Route } from "./routes";
import type { AgentsScreen } from "./redesign/agents/AgentsRedesign";

type RouteName = Route["name"];

const AGENTS = "agents";

/** Rail item lit for a route whose name is not its rail id. */
const RAIL_ID: Partial<Record<RouteName, string>> = {
  connect: "settings",
  detail: "runs",
  new: "inbox",
  pipeline: "pipelines",
  workshop: "pipelines",
  task: "tasks",
  trigger: "triggers",
  connection: "connections",
  agentSessions: "agent-sessions",
  agents: AGENTS,
  agentCreate: AGENTS,
  agent: AGENTS,
  agentSession: AGENTS,
  agentRun: AGENTS,
};

/** With the redesign on, skills and extensions all live under Catalog. */
const REDESIGN_RAIL_ID: Partial<Record<RouteName, string>> = {
  catalog: "catalog",
  stage: "catalog",
  skill: "catalog",
  skills: "catalog",
  extensions: "catalog",
  extensionPackage: "catalog",
  extensionFile: "catalog",
};

const LEGACY_RAIL_ID: Partial<Record<RouteName, string>> = {
  skill: "skills",
  extensionPackage: "extensions",
  extensionFile: "extensions",
};

export function railActiveId(route: Route, redesignOn: boolean): string {
  return RAIL_ID[route.name] ?? (redesignOn ? REDESIGN_RAIL_ID : LEGACY_RAIL_ID)[route.name] ?? route.name;
}

export type AgentsRouteProps = { screen: AgentsScreen; agentId?: string; sessionId?: string; runId?: string };

/** Props for the Agents area when `route` belongs to it (every agent route except the sessions list), else null. */
export function agentsRouteProps(route: Route): AgentsRouteProps | null {
  switch (route.name) {
    case "agents":
      return { screen: "directory" };
    case "agentCreate":
      return { screen: "create" };
    case "agent":
      return { screen: route.screen, agentId: route.agentId };
    case "agentSession":
      return { screen: "session", agentId: route.agentId, sessionId: route.sessionId };
    case "agentRun":
      return { screen: "run", agentId: route.agentId, sessionId: route.sessionId, runId: route.runId };
    default:
      return null;
  }
}
