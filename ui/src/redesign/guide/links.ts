import {
  agentPath,
  connectionPath,
  datasetPath,
  evalPath,
  memoryPath,
  pipelinePath,
  runStreamPath,
  stagePath,
  taskPath,
  triggerPath,
} from "../../routes";
import type { GuideLink, GuideLinkKind } from "./api";

function consolePath(link: GuideLink): string | null {
  const root = link.projectRoot ? { project_root: link.projectRoot } : undefined;
  switch (link.kind) {
    case "pipeline":
      return pipelinePath(link.id, root);
    case "stage":
      return link.path ? stagePath(link.path, root) : null;
    case "task":
      return taskPath(link.id);
    case "agent":
      return agentPath(link.id);
    case "trigger":
      return triggerPath(link.id, link.projectRoot);
    case "eval":
      return evalPath(link.id);
    case "eval_run":
      return null;
    case "dataset":
      return datasetPath(link.id);
    case "connection":
      return connectionPath(link.id);
    case "memory":
      return memoryPath(link.id);
    case "run":
      return runStreamPath(link.id);
  }
}

/** Hash href for a console page, or null when the console has no page for this link. */
export function guideLinkHref(link: GuideLink): string | null {
  if (!link.id) return null;
  const path = consolePath(link);
  return path ? `#${path}` : null;
}

const KIND_LABELS: Record<GuideLinkKind, string> = {
  pipeline: "Pipeline",
  stage: "Stage",
  task: "Task",
  agent: "Agent",
  trigger: "Trigger",
  eval: "Eval",
  eval_run: "Eval run",
  dataset: "Dataset",
  connection: "Connection",
  memory: "Memory",
  run: "Run",
};

export function guideLinkKindLabel(kind: GuideLinkKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function guideLinkLabel(link: GuideLink): string {
  return link.label || link.id;
}
