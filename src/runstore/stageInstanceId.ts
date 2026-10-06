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

export function mintCloneInstanceIds(
  catalogId: string,
  count: number,
  startAt = 1,
): string[] {
  guardPositiveInteger(count, "count");
  guardPositiveInteger(startAt, "startAt");
  return Array.from({ length: count }, (_, i) => mintCloneInstanceId(catalogId, startAt + i));
}

export function cloneInstanceOrdinal(
  instanceId: string,
  catalogId: string,
): number | undefined {
  const prefix = `${catalogId}~`;
  if (!instanceId.startsWith(prefix)) return undefined;
  const n = Number(instanceId.slice(prefix.length));
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export function definitionIdForInstance(
  snapshot: RunPipelineDagSnapshot | null | undefined,
  instanceId: string,
): string {
  const node = snapshot?.nodes.find((n) => n.id === instanceId);
  if (!node) return instanceId;
  return node.definition_id ?? node.id;
}
