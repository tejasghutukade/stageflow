import { readFileSync } from "node:fs";
import type { AgentDefinition } from "../config/loadAgent.js";
import path from "node:path";
import {
  parseFunctionFile,
  resolveFunctionDefinitionPathsSync,
  type FunctionDefinition,
  type FunctionGrant,
} from "../config/loadFunction.js";

export type EffectiveFunctionPolicy = {
  files: Array<{ root: string; path: string; access: string }>;
  env: string[];
  apis: Array<{ origin: string; methods: string[]; path_prefix: string; access: string }>;
};

export function effectiveFunctionPolicy(
  definition: FunctionDefinition,
  grants: readonly FunctionGrant[],
): EffectiveFunctionPolicy {
  const files: EffectiveFunctionPolicy["files"] = [];
  const env: string[] = [];
  const apis: EffectiveFunctionPolicy["apis"] = [];
  const byId = new Map(definition.capabilities.map((capability) => [capability.id, capability]));
  for (const grant of grants) {
    const capability = byId.get(grant.id);
    if (!capability) continue;
    if (capability.type === "file") {
      if (grant.root !== undefined && grant.root !== capability.root) continue;
      if (grant.path !== undefined && grant.path !== capability.path) continue;
      files.push({ root: capability.root, path: capability.path, access: capability.access });
      continue;
    }
    if (capability.type === "env") {
      env.push(capability.alias);
      continue;
    }
    if (grant.origin !== undefined && grant.origin !== capability.origin) continue;
    if (grant.path_prefix !== undefined && grant.path_prefix !== capability.path_prefix) continue;
    if (grant.credential_ref !== undefined && grant.credential_ref !== capability.credential_ref) continue;
    if (grant.methods !== undefined && grant.methods.some((method) => !capability.methods.includes(method))) continue;
    const methods = grant.methods === undefined ? capability.methods : capability.methods.filter((method) => grant.methods?.includes(method));
    apis.push({
      origin: capability.origin,
      methods: [...methods].sort(),
      path_prefix: capability.path_prefix,
      access: capability.effect,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path) || a.root.localeCompare(b.root));
  env.sort();
  apis.sort((a, b) => a.origin.localeCompare(b.origin) || a.path_prefix.localeCompare(b.path_prefix));
  return { files, env, apis };
}

export function classifyEffectivePolicy(policy: EffectiveFunctionPolicy): {
  class: "read" | "write" | "external";
  readOnly: boolean;
  askFirst: boolean;
} {
  const write = policy.files.some((file) => file.access === "write");
  const action = policy.apis.some((api) => api.access === "action");
  const api = policy.apis.length > 0;
  if (action || api) return { class: "external", readOnly: false, askFirst: write || action };
  if (write) return { class: "write", readOnly: false, askFirst: true };
  return { class: "read", readOnly: true, askFirst: false };
}

export function readFunctionDefinitionSync(projectRoot: string, functionId: string): FunctionDefinition | undefined {
  const paths = resolveFunctionDefinitionPathsSync(projectRoot, functionId);
  if (paths.length !== 1) return undefined;
  try {
    const filePath = paths[0]!;
    const parsed = parseFunctionFile(readFileSync(filePath, "utf8"), path.basename(filePath));
    if (!parsed.ok || parsed.value.id !== functionId) return undefined;
    return parsed.value;
  } catch {
    return undefined;
  }
}

export function functionToolAsksFirst(
  definition: Pick<AgentDefinition, "approvals" | "tools">,
  toolId: string,
  projectRoot: string | undefined,
): boolean {
  if (!toolId.startsWith("function.")) return false;
  const id = toolId.slice("function.".length);
  const attachment = definition.tools.functions?.find((item) => item.id === id);
  if (!attachment) return false;
  if (!projectRoot) return true;
  const fn = readFunctionDefinitionSync(projectRoot, id);
  if (!fn || fn.kind !== "tool") return true;
  if (fn.tool_name && definition.approvals.ask_first.includes(fn.tool_name)) return true;
  return classifyEffectivePolicy(effectiveFunctionPolicy(fn, attachment.grants)).askFirst;
}
