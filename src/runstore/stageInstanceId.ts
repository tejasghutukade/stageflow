import { guardStageId } from "./workspaceLayout.js";
import type { RunPipelineDagSnapshot } from "./port.js";

function guardPositiveInteger(n: number, label: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function mintCloneInstanceId(catalogId: string, n: number): string {
  guardPositiveInteger(n, "n");
  guardStageId(catalogId);
  const instanceId = `${catalogId}~${n}`;
  guardStageId(instanceId);
  return instanceId;
}

export function mintCloneInstanceIds(catalogId: string, count: number): string[] {
  guardPositiveInteger(count, "count");
  return Array.from({ length: count }, (_, i) => mintCloneInstanceId(catalogId, i + 1));
}

export function definitionIdForInstance(
  snapshot: RunPipelineDagSnapshot | null | undefined,
  instanceId: string,
): string {
  const node = snapshot?.nodes.find((n) => n.id === instanceId);
  if (!node) return instanceId;
  return node.definition_id ?? node.id;
}
