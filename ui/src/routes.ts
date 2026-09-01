export type DetailView =
  | { kind: "stream"; stageId?: string }
  | { kind: "envelope"; stageId: string }
  | { kind: "artifact"; path: string };

export type Route =
  | { name: "today" }
  | { name: "runs" }
  | { name: "new"; pipelineId?: string; taskPath?: string }
  | { name: "detail"; runId: string; view: DetailView }
  | { name: "pipelines" }
  | { name: "pipeline"; pipelineId: string }
  | { name: "tasks" }
  | { name: "task"; taskId: string }
  | { name: "skills" }
  | { name: "skill"; skillName: string }
  | { name: "extensions" }
  | {
      name: "extensionPackage";
      scope: "user" | "project";
      source: string;
    }
  | { name: "extensionFile"; path: string }
  | { name: "settings" }
  | { name: "connect" };

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

export function pipelinePath(pipelineId: string): string {
  return `/pipelines/${encodeURIComponent(pipelineId)}`;
}

export function taskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

export function skillPath(name: string): string {
  return `/skills/${encodeURIComponent(name)}`;
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

export function connectPath(): string {
  return "/connect";
}

export function newRunPath(opts?: {
  pipeline?: string;
  task?: string;
}): string {
  const params = new URLSearchParams();
  if (opts?.pipeline) params.set("pipeline", opts.pipeline);
  if (opts?.task) params.set("task", opts.task);
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
  if (!path || path === "today") return { name: "today" };
  if (path === "runs") return { name: "runs" };
  if (path === "new") {
    const pipelineId = params.get("pipeline") ?? undefined;
    const taskPath = params.get("task") ?? undefined;
    return {
      name: "new",
      ...(pipelineId ? { pipelineId } : {}),
      ...(taskPath ? { taskPath } : {}),
    };
  }
  if (path === "pipelines") return { name: "pipelines" };
  if (path.startsWith("pipelines/")) {
    const pipelineId = firstSegment(path.slice("pipelines/".length));
    if (pipelineId) return { name: "pipeline", pipelineId };
  }
  if (path === "tasks") return { name: "tasks" };
  if (path.startsWith("tasks/")) {
    const taskId = firstSegment(path.slice("tasks/".length));
    if (taskId) return { name: "task", taskId };
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
  if (path.startsWith("runs/")) {
    const parts = path.slice("runs/".length).split("/");
    const runId = decodeURIComponent(parts[0] ?? "");
    if (!runId) return { name: "today" };
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
  return { name: "today" };
}
