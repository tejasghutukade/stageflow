import type {
  LoadedPipeline,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";

const MIN_BOX_WIDTH = 12;
const TOP_OVERHEAD = 5;
const BODY_OVERHEAD = 3;
const BOTTOM_OVERHEAD = 2;

function cloneChainLabel(node: ResolvedPipelineStageNode): string | null {
  if (node.clone_cap === undefined) return null;
  const mode = node.clone_mode ?? "parallel";
  return `\u00d7 up to ${node.clone_cap} (${mode})`;
}

function sendBackLabel(node: ResolvedPipelineStageNode): string | null {
  const policy = node.feedback_loop;
  if (!policy) return null;
  const maxReplays = policy.max_replays === undefined ? "\u221e" : String(policy.max_replays);
  return `\u21a9 send_back \u2192 ${policy.target} (max ${maxReplays} replays)`;
}

function boxLines(node: ResolvedPipelineStageNode, targets: string[]): string[] {
  const idLine = node.entry === true ? `${node.id}  ENTRY` : node.id;
  const bodyLines: string[] = [];
  const cloneLabel = cloneChainLabel(node);
  if (cloneLabel) bodyLines.push(cloneLabel);
  const sendBack = sendBackLabel(node);
  if (sendBack) bodyLines.push(sendBack);

  const branchTargets = targets.length > 1 ? targets : [];
  for (const target of branchTargets) {
    bodyLines.push(`\u2192 ${target}`);
  }

  const contentNeed = Math.max(
    idLine.length + TOP_OVERHEAD,
    ...bodyLines.map((line) => line.length + BODY_OVERHEAD),
  );
  const width = Math.max(MIN_BOX_WIDTH, contentNeed);

  const topFill = width - idLine.length - TOP_OVERHEAD;
  const top = `\u250c\u2500 ${idLine} ${"\u2500".repeat(topFill)}\u2510`;
  const lines = [top];
  for (const line of bodyLines) {
    const pad = width - line.length - BODY_OVERHEAD;
    lines.push(`\u2502 ${line}${" ".repeat(pad)}\u2502`);
  }
  lines.push(`\u2514${"\u2500".repeat(width - BOTTOM_OVERHEAD)}\u2518`);
  return lines;
}

/**
 * Renders the pipeline's stages in `dag.nodes` (topological) order as a
 * vertical list of boxes, connected by simple down-arrows. Route edges come
 * from `dag.childrenOf` (already forward-direction resolved data — no new
 * DAG model, no re-derivation from raw YAML). Clone Chain fan-out renders as
 * a single labeled band per stage (never one box per clone instance), and
 * `{ type: loop }` renders as a send_back cue on the source stage (never a
 * second reverse edge).
 */
export function formatGraphHuman(loaded: LoadedPipeline, options: { path?: string } = {}): string {
  const dag = loaded.dag;
  const label = options.path ?? loaded.pipelinePath;
  const lines: string[] = [`Pipeline: ${loaded.pipeline.id} (${label})`, ""];

  const nodes = dag.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const targets = dag.childrenOf[node.id] ?? [];
    const box = boxLines(node, targets);
    lines.push(...box);
    if (i < nodes.length - 1) {
      lines.push("   \u2502");
      lines.push("   \u25bc");
    }
  }

  return lines.join("\n");
}

export function formatGraphJson(dag: ResolvedPipelineDag): string {
  return JSON.stringify(dag, null, 2);
}
