import { resolvePipelineDag } from "../config/resolvePipelineDag.js";
import type { ResolvedPipelineDag, PipelineStageRef } from "../types/pipeline.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

export const GRAPH_USAGE = `Usage:
  sf graph --pipeline <path> [--json]

  Visualize pipeline structure as ASCII/box-drawing diagram.
  --pipeline <path>  Path to pipeline YAML file (required)
  --json             Output resolved DAG as JSON instead of ASCII diagram`;

export type GraphCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: GraphCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedGraphArgs = {
  help: boolean;
  pipeline?: string;
  json: boolean;
};

function parseGraphArgs(args: string[]): ParsedGraphArgs {
  if (args.length === 0) {
    return { help: true, json: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false };
  }

  let pipeline: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --pipeline");
      }
      pipeline = value;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!pipeline && !help) {
    throw new Error("--pipeline is required");
  }

  return { help, pipeline, json };
}

/**
 * Render a proper DAG visualization with ASCII/box-drawing characters
 * Shows stages as nodes, routes as edges, entry points, clone chains, and loops
 */
function renderDagDiagram(dag: ResolvedPipelineDag, stageRefs: PipelineStageRef[]): string {
  const lines: string[] = [];
  
  // Header
  lines.push("Pipeline Graph Visualization:");
  lines.push("============================");
  lines.push("");
  
  // Track clone chains
  const cloneChains = new Map<string, { cap: number; mode: string }>();
  
  // Identify clone chains
  stageRefs.forEach(ref => {
    if (ref.clone_cap !== undefined && ref.clone_cap > 1) {
      cloneChains.set(ref.id, { 
        cap: ref.clone_cap, 
        mode: ref.clone_mode || 'parallel' 
      });
    }
  });
  
  // Find entry stages
  const entryStages = dag.nodes.filter(node => node.entry).map(node => node.id);
  
  // Find loop stages
  const loopStages = dag.nodes.filter(node => node.feedback_loop);
  
  // Create a proper hierarchical layout
  // Build adjacency list for parents (reverse of childrenOf)
  const parentsOf: Record<string, string[]> = {};
  Object.entries(dag.childrenOf).forEach(([parentId, children]) => {
    children.forEach(childId => {
      if (!parentsOf[childId]) parentsOf[childId] = [];
      parentsOf[childId].push(parentId);
    });
  });
  
  // Find root nodes (nodes with no parents)
  const rootNodes = dag.nodes.filter(node => !parentsOf[node.id] || parentsOf[node.id].length === 0);
  
  // Sort nodes for consistent ordering
  rootNodes.sort((a, b) => a.id.localeCompare(b.id));
  
  // Track visited nodes to avoid cycles
  const visited = new Set<string>();
  const rendered = new Set<string>();
  
  // Function to render a node and its connections
  function renderNode(nodeId: string, prefix: string = "", isLast: boolean = true, depth: number = 0): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    
    const node = dag.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    if (rendered.has(nodeId)) return;
    rendered.add(nodeId);
    
    // Build stage label with markers
    let stageLabel = node.id;
    if (entryStages.includes(nodeId)) {
      stageLabel = `[ENTRY] ${stageLabel}`;
    }
    
    // Create the node box with proper sizing (max 20 chars for 80-column readability)
    const maxWidth = 20;
    const truncatedLabel = stageLabel.length > maxWidth ? stageLabel.substring(0, maxWidth - 3) + "..." : stageLabel;
    const boxWidth = Math.max(truncatedLabel.length + 4, 12);
    const padding = Math.floor((boxWidth - truncatedLabel.length - 2) / 2);
    const paddingLeft = ' '.repeat(padding);
    const paddingRight = ' '.repeat(boxWidth - truncatedLabel.length - 2 - padding);
    
    // Render the node box
    lines.push(`${prefix}┌${'─'.repeat(boxWidth - 2)}┐`);
    lines.push(`${prefix}│${paddingLeft}${truncatedLabel}${paddingRight}│`);
    lines.push(`${prefix}└${'─'.repeat(boxWidth - 2)}┘`);
    
    // Add clone chain indicator as a labeled band if applicable
    if (cloneChains.has(nodeId)) {
      const cloneInfo = cloneChains.get(nodeId)!;
      lines.push(`${prefix}╘══════════════════╛`);
      lines.push(`${prefix} child~${cloneInfo.cap} (${cloneInfo.mode})`);
      lines.push(`${prefix}╒══════════════════╕`);
    }
    
    // Add loop indicator if applicable
    const loopStage = loopStages.find(ls => ls.id === nodeId);
    if (loopStage && loopStage.feedback_loop) {
      lines.push(`${prefix}↩ [LOOP] send_back to: ${loopStage.feedback_loop.target}`);
    }
    
    // Render outgoing connections
    const children = dag.childrenOf[nodeId] || [];
    
    // Sort children for consistent ordering
    children.sort((a, b) => a.localeCompare(b));
    
    children.forEach((childId, index) => {
      const isLastChild = index === children.length - 1;
      const childPrefix = prefix + (isLast ? "  " : "│ ");
      
      // Draw connection arrow
      lines.push(`${childPrefix}${isLastChild ? '└' : '├'}──▶`);
      
      // Recursively render child if not already rendered
      if (!rendered.has(childId)) {
        renderNode(childId, childPrefix + (isLastChild ? "   " : "│  "), isLastChild, depth + 1);
      } else {
        // Just show reference to already rendered node
        lines.push(`${childPrefix}   │`);
        lines.push(`${childPrefix}   └──▶ [${childId}]`);
      }
    });
  }
  
  // Render all root nodes
  rootNodes.forEach((node, index) => {
    if (index > 0) lines.push(""); // Add spacing between disconnected components
    renderNode(node.id);
  });
  
  // Add legend
  lines.push("");
  lines.push("Legend:");
  lines.push("  [ENTRY] stage      - Entry stage");
  lines.push("  ╒═════════════════╕");
  lines.push("  child~N (mode)    - Clone chain fan-out (N instances)");
  lines.push("  ╘═════════════════╛");
  lines.push("  ↩ [LOOP] send_back - Loop return cue to target stage");
  lines.push("  ──▶               - Route connection");
  
  return lines.join('\n');
}

export async function runGraphCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<GraphCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: GraphCommandIo = { ...defaultIo, ...options.io };

  try {
    const parsed = parseGraphArgs(args);
    if (parsed.help) {
      out.error(GRAPH_USAGE);
      return 0;
    }

    if (!parsed.pipeline) {
      throw new Error("--pipeline is required");
    }

    // Validate pipeline path to prevent path traversal
    const resolvedPath = resolve(cwd, parsed.pipeline);
    const resolvedProjectRoot = resolve(projectRoot);
    
    // Ensure the pipeline file is within the project root
    if (!resolvedPath.startsWith(resolvedProjectRoot)) {
      throw new Error(`Pipeline path must be within project root: ${parsed.pipeline}`);
    }

    // Read and parse the pipeline file
    const pipelineContent = readFileSync(resolvedPath, 'utf8');
    const documents = parseAllDocuments(pipelineContent);
    
    if (documents.length === 0) {
      throw new Error(`No YAML documents found in ${parsed.pipeline}`);
    }
    
    const pipelineDoc = documents[0]!.toJS();
    
    if (!pipelineDoc.stages || !Array.isArray(pipelineDoc.stages)) {
      throw new Error(`Invalid pipeline: stages[] is required`);
    }
    
    // Resolve the DAG using existing functionality
    const ctx = {
      pipelineId: resolvedPath,
      path: resolvedPath,
    };
    
    const { dag } = resolvePipelineDag(pipelineDoc.stages, ctx);
    
    if (parsed.json) {
      // Output JSON format
      out.log(JSON.stringify(dag, null, 2));
    } else {
      // Output ASCII diagram
      const diagram = renderDagDiagram(dag, pipelineDoc.stages);
      out.log(diagram);
    }

    return 0;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Graph command failed";
    out.error(message);
    out.error(GRAPH_USAGE);
    return 1;
  }
}