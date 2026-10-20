import type { InboxTabId } from "./redesign/inbox/inboxTab";
import { inboxPath as inboxPathWithTab } from "./redesign/inbox/inboxTab";

export type DetailView =
  | { kind: "stream"; stageId?: string }
  | { kind: "envelope"; stageId: string }
  | { kind: "artifact"; path: string };

export type Route =
  | { name: "today" }
  | { name: "overview" }
  | { name: "inbox"; tab?: InboxTabId }
  | { name: "runs" }
  | { name: "new"; pipelineId?: string; taskPath?: string; projectRoot?: string }
  | { name: "detail"; runId: string; view: DetailView }
  | { name: "pipelines" }
  | { name: "pipeline"; pipelineId: string; projectRoot?: string }
  | { name: "tasks" }
  | { name: "task"; taskId: string }
  | { name: "triggers" }
  | { name: "connections" }
  | { name: "connection"; connectionId: string }
  | { name: "agents" }
  | { name: "agentSessions" }
  | { name: "agentCreate" }
  | { name: "agent"; agentId: string; screen: "detail" | "edit" }
  | { name: "agentSession"; agentId: string; sessionId: string }
  | { name: "agentRun"; agentId: string; sessionId: string; runId: string }
  | { name: "trigger"; triggerId: string; projectRoot?: string }
  | { name: "skills" }
  | { name: "skill"; skillName: string }
  | {
      name: "catalog";
      tab?: "stages" | "skills" | "extensions";
      skillName?: string;
    }
  | { name: "stage"; path: string; projectRoot?: string }
  | { name: "extensions" }
  | {
      name: "extensionPackage";
      scope: "user" | "project";
      source: string;
    }
  | { name: "extensionFile"; path: string }
  | { name: "settings" }
  | { name: "connect" }
  | {
      name: "workshop";
      sessionId?: string;
      pipelinePath?: string;
      taskPath?: string;
      projectRoot?: string;
    };

export function navigate(to: string): void {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}

export function runStreamPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

export function runStagePath(runId: string, stageId: string): string {
  return `/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}`;
}

export function runArtifactPath(runId: string, path: string): string {
  return `/runs/${encodeURIComponent(runId)}/artifacts?path=${encodeURIComponent(path)}`;
}

export function runEnvelopePath(runId: string, stageId: string): string {
  return `/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/envelope`;
}

export function pipelinePath(
  pipelineId: string,
  opts?: { project_root?: string },
): string {
  const base = `/pipelines/${encodeURIComponent(pipelineId)}`;
  if (!opts?.project_root) return base;
  const params = new URLSearchParams();
  params.set("project_root", opts.project_root);
  return `${base}?${params.toString()}`;
}

export function resolvePipelineListing<
  T extends { id: string; project_root?: string },
>(pipelines: T[], pipelineId: string, projectRoot?: string): T | null {
  if (projectRoot) {
    const exact = pipelines.find(
      (p) => p.id === pipelineId && p.project_root === projectRoot,
    );
    if (exact) return exact;
  }
  return pipelines.find((p) => p.id === pipelineId) ?? null;
}

export function taskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

export function triggerPath(triggerId: string, projectRoot?: string): string {
  const base = `/triggers/${encodeURIComponent(triggerId)}`;
  if (!projectRoot) return base;
  return `${base}?${new URLSearchParams({ project_root: projectRoot })}`;
}

export function skillPath(name: string): string {
  return `/skills/${encodeURIComponent(name)}`;
}

export function catalogPath(opts?: {
  tab?: "stages" | "skills" | "extensions";
  skill?: string;
}): string {
  const params = new URLSearchParams();
  if (opts?.tab) params.set("tab", opts.tab);
  if (opts?.skill) params.set("skill", opts.skill);
  const query = params.toString();
  return query ? `/catalog?${query}` : "/catalog";
}

export function stagePath(
  stageFilePath: string,
  opts?: { project_root?: string },
): string {
  const base = `/stages/${encodeURIComponent(stageFilePath)}`;
  if (!opts?.project_root) return base;
  const params = new URLSearchParams();
  params.set("project_root", opts.project_root);
  return `${base}?${params.toString()}`;
}

export function extensionPackagePath(
  scope: "user" | "project",
  source: string,
): string {
  return `/extensions/packages/${encodeURIComponent(scope)}/${encodeURIComponent(source)}`;
}

export function extensionFilePath(filePath: string): string {
  return `/extensions/files/${encodeURIComponent(filePath)}`;
}

export function workshopPath(opts?: {
  session?: string;
  pipeline?: string;
  task?: string;
  project_root?: string;
}): string {
  const params = new URLSearchParams();
  if (opts?.session) params.set("session", opts.session);
  if (opts?.pipeline) params.set("pipeline", opts.pipeline);
  if (opts?.task) params.set("task", opts.task);
  if (opts?.project_root) params.set("project_root", opts.project_root);
  const query = params.toString();
  return query ? `/workshop?${query}` : "/workshop";
}

export function connectionPath(connectionId: string): string {
  return `/connections/${encodeURIComponent(connectionId)}`;
}

export function agentsPath(): string {
  return "/agents";
}

export function agentSessionsPath(): string {
  return "/agent-sessions";
}

export function agentCreatePath(): string {
  return "/agents/new";
}

export function agentPath(agentId: string, screen: "detail" | "edit" = "detail"): string {
  const base = `/agents/${encodeURIComponent(agentId)}`;
  return screen === "edit" ? `${base}/edit` : base;
}

export function agentSessionPath(agentId: string, sessionId: string): string {
  return `${agentPath(agentId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function agentRunPath(agentId: string, sessionId: string, runId: string): string {
  return `${agentSessionPath(agentId, sessionId)}/runs/${encodeURIComponent(runId)}`;
}

export function connectPath(): string {
  return "/connect";
}

export function inboxPath(tab?: InboxTabId): string {
  return inboxPathWithTab(tab ?? "needs");
}

export function newRunPath(opts?: {
  pipeline?: string;
  task?: string;
  project_root?: string;
}): string {
  const params = new URLSearchParams();
  if (opts?.pipeline) params.set("pipeline", opts.pipeline);
  if (opts?.task) params.set("task", opts.task);
  if (opts?.project_root) params.set("project_root", opts.project_root);
  const query = params.toString();
  return query ? `/new?${query}` : "/new";
}

function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const stripped = hash.replace(/^#\/?/, "");
  const q = stripped.indexOf("?");
  if (q < 0) return { path: stripped, params: new URLSearchParams() };
  return {
    path: stripped.slice(0, q),
    params: new URLSearchParams(stripped.slice(q + 1)),
  };
}

function firstSegment(rest: string): string {
  const slash = rest.indexOf("/");
  const raw = slash < 0 ? rest : rest.slice(0, slash);
  return raw ? decodeURIComponent(raw) : "";
}

export function parseHash(hash = window.location.hash): Route {
  const { path, params } = splitHash(hash);
  if (!path || path === "today") return { name: "inbox" };
  if (path === "overview") return { name: "overview" };
  if (path === "inbox") {
    const tabRaw = params.get("tab");
    const tab: InboxTabId | undefined =
      tabRaw === "failed" || tabRaw === "done_today" ? tabRaw : undefined;
    return tab ? { name: "inbox", tab } : { name: "inbox" };
  }
  if (path === "runs") return { name: "runs" };
  if (path === "new") {
    const pipelineId = params.get("pipeline") ?? undefined;
    const taskPath = params.get("task") ?? undefined;
    const projectRoot = params.get("project_root") ?? undefined;
    return {
      name: "new",
      ...(pipelineId ? { pipelineId } : {}),
      ...(taskPath ? { taskPath } : {}),
      ...(projectRoot ? { projectRoot } : {}),
    };
  }
  if (path === "pipelines") return { name: "pipelines" };
  if (path.startsWith("pipelines/")) {
    const pipelineId = firstSegment(path.slice("pipelines/".length));
    if (pipelineId) {
      const projectRoot = params.get("project_root") ?? undefined;
      return {
        name: "pipeline",
        pipelineId,
        ...(projectRoot ? { projectRoot } : {}),
      };
    }
  }
  if (path === "tasks") return { name: "tasks" };
  if (path.startsWith("tasks/")) {
    const taskId = firstSegment(path.slice("tasks/".length));
    if (taskId) return { name: "task", taskId };
  }
  if (path === "triggers") return { name: "triggers" };
  if (path === "connections") return { name: "connections" };
  if (path.startsWith("connections/")) {
    const connectionId = firstSegment(path.slice("connections/".length));
    if (connectionId) return { name: "connection", connectionId };
  }
  if (path === "agent-sessions" || path === "agents/sessions") return { name: "agentSessions" };
  if (path === "agents") return { name: "agents" };
  if (path === "agents/new") return { name: "agentCreate" };
  if (path.startsWith("agents/")) {
    const rest = path.slice("agents/".length);
    const slash = rest.indexOf("/");
    const agentId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const tail = slash < 0 ? "" : rest.slice(slash + 1);
    if (agentId === "new") return { name: "agentCreate" };
    if (!agentId) return { name: "agents" };
    if (tail === "edit") return { name: "agent", agentId, screen: "edit" };
    const session = /^sessions\/([^/]+)(?:\/runs\/([^/]+))?$/.exec(tail);
    if (session) {
      const sessionId = decodeURIComponent(session[1]!);
      if (session[2]) return { name: "agentRun", agentId, sessionId, runId: decodeURIComponent(session[2]) };
      return { name: "agentSession", agentId, sessionId };
    }
    if (tail === "") return { name: "agent", agentId, screen: "detail" };
  }
  if (path.startsWith("triggers/")) {
    const triggerId = firstSegment(path.slice("triggers/".length));
    if (triggerId) {
      const projectRoot = params.get("project_root") ?? undefined;
      return {
        name: "trigger",
        triggerId,
        ...(projectRoot ? { projectRoot } : {}),
      };
    }
  }
  if (path === "catalog") {
    const tabRaw = params.get("tab");
    const tab =
      tabRaw === "skills" || tabRaw === "extensions" || tabRaw === "stages"
        ? tabRaw
        : "stages";
    const skillName = params.get("skill") ?? undefined;
    return {
      name: "catalog",
      tab,
      ...(skillName ? { skillName } : {}),
    };
  }
  if (path.startsWith("stages/")) {
    const filePath = decodeURIComponent(path.slice("stages/".length));
    if (filePath) {
      const projectRoot = params.get("project_root") ?? undefined;
      return {
        name: "stage",
        path: filePath,
        ...(projectRoot ? { projectRoot } : {}),
      };
    }
  }
  if (path === "skills") return { name: "skills" };
  if (path.startsWith("skills/")) {
    const skillName = firstSegment(path.slice("skills/".length));
    if (skillName) return { name: "skill", skillName };
  }
  if (path === "extensions") return { name: "extensions" };
  if (path.startsWith("extensions/packages/")) {
    const rest = path.slice("extensions/packages/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const scopeRaw = decodeURIComponent(rest.slice(0, slash));
      const source = decodeURIComponent(rest.slice(slash + 1));
      if (
        (scopeRaw === "user" || scopeRaw === "project") &&
        source
      ) {
        return { name: "extensionPackage", scope: scopeRaw, source };
      }
    }
  }
  if (path.startsWith("extensions/files/")) {
    const filePath = decodeURIComponent(
      path.slice("extensions/files/".length),
    );
    if (filePath) return { name: "extensionFile", path: filePath };
  }
  if (path === "settings") return { name: "settings" };
  if (path === "connect") return { name: "connect" };
  if (path === "workshop" || path === "workshop-lab") {
    const sessionId = params.get("session") ?? undefined;
    const pipelinePath = params.get("pipeline") ?? undefined;
    const taskPath = params.get("task") ?? undefined;
    const projectRoot = params.get("project_root") ?? undefined;
    return {
      name: "workshop",
      ...(sessionId ? { sessionId } : {}),
      ...(pipelinePath ? { pipelinePath } : {}),
      ...(taskPath ? { taskPath } : {}),
      ...(projectRoot ? { projectRoot } : {}),
    };
  }
  if (path.startsWith("runs/")) {
    const parts = path.slice("runs/".length).split("/");
    const runId = decodeURIComponent(parts[0] ?? "");
    if (!runId) return { name: "inbox" };
    if (
      parts[1] === "stages" &&
      parts[3] === "envelope" &&
      parts[2] &&
      parts.length === 4
    ) {
      return {
        name: "detail",
        runId,
        view: {
          kind: "envelope",
          stageId: decodeURIComponent(parts[2]),
        },
      };
    }
    if (parts[1] === "stages" && parts[2] && parts.length === 3) {
      return {
        name: "detail",
        runId,
        view: {
          kind: "stream",
          stageId: decodeURIComponent(parts[2]),
        },
      };
    }
    if (parts[1] === "artifacts" && parts.length === 2) {
      const artifactPath = params.get("path");
      if (artifactPath) {
        return {
          name: "detail",
          runId,
          view: { kind: "artifact", path: artifactPath },
        };
      }
    }
    if (parts.length === 1) {
      return { name: "detail", runId, view: { kind: "stream" } };
    }
    return { name: "detail", runId, view: { kind: "stream" } };
  }
  return { name: "inbox" };
}
