import { loadPipeline } from "../config/loadPipeline.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import path from "node:path";

export const GRAPH_USAGE = `Usage:
  sf graph --pipeline <path> [--json]

  Displays a terminal-based visualization of a pipeline's structure.
  --pipeline is required to specify the pipeline file to visualize.
  --json outputs the resolved DAG data in JSON format instead of ASCII diagram.`;

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
    return { help: false, json: false };
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
      throw new Error("Unknown flag: " + arg);
    } else {
      throw new Error("Unexpected argument: " + arg);
    }
  }

  return { help, pipeline, json };
}

/**
 * Render an ASCII diagram of the pipeline DAG
 */
function renderAsciiDiagram(dag: ResolvedPipelineDag, out: GraphCommandIo): void {
  out.log("Pipeline Graph:");
  out.log("==================================================");
  
  // Create a map of nodes by ID for quick lookup
  const nodeMap = new Map(dag.nodes.map(node => [node.id, node]));
  
  // Track which nodes we've already rendered to avoid duplication
  const renderedNodes = new Set<string>();
  
  // Find all root nodes (entry points)
  const rootNodes = dag.nodes.filter(node => node.entry);
  
  // Render each node with proper connections
  for (const rootNode of rootNodes) {
    renderNodeWithCloneInfo(rootNode, nodeMap, dag.childrenOf, out, "", true, renderedNodes);
    out.log("");
  }
  
  // Render any remaining nodes that aren't connected to roots
  for (const node of dag.nodes) {
    if (!renderedNodes.has(node.id)) {
      renderNodeWithCloneInfo(node, nodeMap, dag.childrenOf, out, "", true, renderedNodes);
      out.log("");
    }
  }
}

/**
 * Recursively render a node and its children with enhanced clone chain visualization
 */
function renderNodeWithCloneInfo(
  node: ResolvedPipelineDag["nodes"][number],
  nodeMap: Map<string, ResolvedPipelineDag["nodes"][number]>,
  childrenOf: ResolvedPipelineDag["childrenOf"],
  out: GraphCommandIo,
  prefix: string,
  isLast: boolean,
  renderedNodes: Set<string>
): void {
  if (renderedNodes.has(node.id)) return;
  renderedNodes.add(node.id);
  
  let line = prefix;
  
  // Add tree structure prefix
  if (prefix) {
    line += isLast ? "└─ " : "├─ ";
  }
  
  // Mark entry points
  if (node.entry) {
    line += "[ENTRY] ";
  }
  
  line += node.id;
  
  // Show clone information
  if (node.clone_cap !== undefined || node.clone_mode !== undefined) {
    const cloneInfo = [];
    if (node.clone_cap !== undefined) cloneInfo.push("cap:" + node.clone_cap);
    if (node.clone_mode !== undefined) cloneInfo.push("mode:" + node.clone_mode);
    if (cloneInfo.length > 0) {
      line += " [clone " + cloneInfo.join(", ") + "]";
    }
  }
  
  // Show feedback loop information
  if (node.feedback_loop) {
    line += " [loop -> " + node.feedback_loop.target + "]";
  }
  
  // Truncate line to 80 characters if needed
  if (line.length > 80) {
    line = line.substring(0, 77) + "...";
  }
  
  out.log(line);
  
  // Show children connections with proper tree structure
  const children = childrenOf[node.id] || [];
  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    const isChildLast = i === children.length - 1;
    const childNode = nodeMap.get(childId);
    
    if (childNode) {
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      renderNodeWithCloneInfo(childNode, nodeMap, childrenOf, out, childPrefix, isChildLast, renderedNodes);
    }
  }
}

/**
 * Enhanced rendering focusing on better visualization of clone chains and relationships
 */
function renderEnhancedAsciiDiagram(dag: ResolvedPipelineDag, out: GraphCommandIo): void {
  out.log("Pipeline Graph:");
  out.log("");
  
  // Group nodes by their clone properties for better visualization
  const cloneGroups = new Map<string, ResolvedPipelineDag["nodes"][number][]>();
  
  // Create a map of nodes by ID for quick lookup
  const nodeMap = new Map(dag.nodes.map(node => [node.id, node]));
  
  // Track which nodes we've already rendered
  const renderedNodes = new Set<string>();
  
  // Find all root nodes (entry points)
  const rootNodes = dag.nodes.filter(node => node.entry);
  
  // Render each connected component starting from root nodes
  for (const rootNode of rootNodes) {
    renderConnectedComponent(rootNode, nodeMap, dag.childrenOf, out, "", renderedNodes);
    out.log("");
  }
  
  // Render any remaining disconnected nodes
  for (const node of dag.nodes) {
    if (!renderedNodes.has(node.id)) {
      renderConnectedComponent(node, nodeMap, dag.childrenOf, out, "", renderedNodes);
      out.log("");
    }
  }
}

/**
 * Render a connected component of the graph with enhanced visualization
 */
function renderConnectedComponent(
  node: ResolvedPipelineDag["nodes"][number],
  nodeMap: Map<string, ResolvedPipelineDag["nodes"][number]>,
  childrenOf: ResolvedPipelineDag["childrenOf"],
  out: GraphCommandIo,
  prefix: string,
  renderedNodes: Set<string>
): void {
  if (renderedNodes.has(node.id)) return;
  renderedNodes.add(node.id);
  
  // Format the node line with proper indentation
  let line = prefix;
  
  // Mark entry points
  if (node.entry) {
    line += "[ENTRY] ";
  }
  
  line += node.id;
  
  // Show clone information in a more descriptive way
  if (node.clone_cap !== undefined || node.clone_mode !== undefined) {
    const parts = [];
    if (node.clone_cap !== undefined) parts.push(`cap:${node.clone_cap}`);
    if (node.clone_mode !== undefined) parts.push(`mode:${node.clone_mode}`);
    line += ` [clone ${parts.join(", ")}]`;
  }
  
  // Show feedback loop information
  if (node.feedback_loop) {
    line += ` [loop -> ${node.feedback_loop.target}]`;
  }
  
  // Enforce 80-character terminal width limit
  if (line.length > 80) {
    line = line.substring(0, 77) + "...";
  }
  
  out.log(line);
  
  // Render children with proper tree structure
  const children = childrenOf[node.id] || [];
  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    const childNode = nodeMap.get(childId);
    
    if (childNode) {
      // Calculate prefix for child nodes
      const isLastChild = i === children.length - 1;
      const childPrefix = prefix + (isLastChild ? "   " : "│  ");
      
      // Recursively render the child
      renderConnectedComponent(childNode, nodeMap, childrenOf, out, childPrefix, renderedNodes);
    }
  }
}

/**
 * Render JSON representation of the pipeline DAG
 */
function renderJson(dag: ResolvedPipelineDag, out: GraphCommandIo): void {
  out.log(JSON.stringify(dag, null, 2));
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
      throw new Error("Missing required --pipeline argument");
    }

    // Load and resolve the pipeline using existing pipeline loader
    const loadedPipeline = await loadPipeline(parsed.pipeline, { cwd, projectRoot });
    const dag = loadedPipeline.dag;

    if (parsed.json) {
      renderJson(dag, out);
    } else {
      renderEnhancedAsciiDiagram(dag, out);
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