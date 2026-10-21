import type {
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";

const MAX_WIDTH = 80;

// Clip to MAX_WIDTH code points so the picture fits an 80-column terminal.
function clampWidth(text: string, max = MAX_WIDTH): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + "…";
}

function cloneModeSuffix(node: ResolvedPipelineStageNode): string {
  return node.clone_mode ? ` (${node.clone_mode})` : "";
}

function buildAnnotations(node: ResolvedPipelineStageNode): string {
  const parts: string[] = [];
  if (node.entry) parts.push("entry");
  if (node.clone_cap !== undefined) {
    parts.push(`clone ${node.clone_cap}${cloneModeSuffix(node)}`);
  }
  if (node.replay_safe === false) {
    parts.push("replay_safe: false");
  }
  return parts.join(" · ");
}

// loadPipeline returns a topologically ordered DAG, so a DF walk over childrenOf yields a stable, dependency-ordered list.
function orderedNodeIds(dag: ResolvedPipelineDag): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    for (const child of dag.childrenOf[id] ?? []) walk(child);
  };
  for (const root of dag.roots) walk(root);
  for (const node of dag.nodes) {
    if (!visited.has(node.id)) walk(node.id);
  }
  return order;
}

function cloneBandLabel(node: ResolvedPipelineStageNode): string {
  if (node.clone_cap === undefined) return "";
  return ` child~${node.clone_cap}${cloneModeSuffix(node)}`;
}

function loopCueLine(node: ResolvedPipelineStageNode): string {
  if (!node.feedback_loop) return "";
  const fl = node.feedback_loop;
  const note = fl.on_max_replays ? `   (${fl.on_max_replays})` : "";
  return `   ↩ loop ×${fl.max_replays} → ${fl.target}${note}`;
}

export function renderGraph(dag: ResolvedPipelineDag): string {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const order = orderedNodeIds(dag);
  const lines: string[] = [];
  const push = (line: string) => lines.push(clampWidth(line));

  order.forEach((id, idx) => {
    const node = byId.get(id)!;
    const marker = node.entry ? "▶ " : "  ";
    const annotations = buildAnnotations(node);
    push(`${marker}${id}` + (annotations ? `   ${annotations}` : ""));

    const loopCue = loopCueLine(node);
    if (loopCue) push(loopCue);

    if (idx < order.length - 1) {
      const children = dag.childrenOf[id] ?? [];
      if (children.length === 1) {
        push("   │");
        push(`   ▼${cloneBandLabel(node)}`);
      } else if (children.length > 1) {
        children.forEach((childId, ci) => {
          const isLast = ci === children.length - 1;
          const branch = isLast ? "└─" : "├─";
          push(`   ${branch}▶ ${childId}${cloneBandLabel(node)}`);
        });
      }
    }
  });

  return lines.join("\n") + "\n";
}
