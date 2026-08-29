import { parseCloneForks } from "./check.js";
import { EnvelopeError } from "../types/envelope.js";
import type { CloneEmitContext, CloneForkItem } from "../types/forkChoice.js";

function fieldPresent(item: CloneForkItem, key: "envelope" | "mode" | "clones"): boolean {
  return (item as Record<string, unknown>)[key] !== undefined;
}

export function assertCloneForks(
  params: unknown,
  cloneEmitContext: CloneEmitContext,
): void {
  const record = params as Record<string, unknown>;
  if (record.status === "failure") return;

  if (record.clone_forks === undefined || !Array.isArray(record.clone_forks)) {
    throw new EnvelopeError("clonable successor requires clone_forks on success");
  }

  const items = parseCloneForks(record.clone_forks);

  if (items.length === 0 && cloneEmitContext.clonableSuccessors.length > 0) {
    throw new EnvelopeError("clone_forks must not be empty when clonable successors exist");
  }

  const expectedIds = cloneEmitContext.clonableSuccessors.map((s) => s.successorId);
  const expectedSet = new Set(expectedIds);
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.successor_id)) {
      throw new EnvelopeError(
        `clone_forks contains duplicate successor_id: ${item.successor_id}`,
      );
    }
    if (!expectedSet.has(item.successor_id)) {
      throw new EnvelopeError(
        `clone_forks contains extra successor_id: ${item.successor_id}`,
      );
    }
    seen.add(item.successor_id);

    const capEntry = cloneEmitContext.clonableSuccessors.find(
      (s) => s.successorId === item.successor_id,
    );
    const cloneCap = capEntry?.cloneCap;

    if (item.action === "skip") {
      if (
        fieldPresent(item, "envelope") ||
        fieldPresent(item, "mode") ||
        fieldPresent(item, "clones")
      ) {
        throw new EnvelopeError(
          `clone_forks skip for ${item.successor_id} must not include envelope, mode, or clones`,
        );
      }
    } else if (item.action === "once") {
      if (!fieldPresent(item, "envelope")) {
        throw new EnvelopeError(
          `clone_forks once for ${item.successor_id} requires envelope`,
        );
      }
      if (fieldPresent(item, "mode") || fieldPresent(item, "clones")) {
        throw new EnvelopeError(
          `clone_forks once for ${item.successor_id} must not include mode or clones`,
        );
      }
    } else if (item.action === "fanout") {
      if (fieldPresent(item, "envelope")) {
        throw new EnvelopeError(
          `clone_forks fanout for ${item.successor_id} must not include a top-level envelope`,
        );
      }
      if (!fieldPresent(item, "mode") || !fieldPresent(item, "clones") || item.clones === undefined) {
        throw new EnvelopeError(
          `clone_forks fanout for ${item.successor_id} requires mode and clones`,
        );
      }
      if (cloneCap === undefined || item.clones.length < 2 || item.clones.length > cloneCap) {
        throw new EnvelopeError(
          `clone_forks fanout for ${item.successor_id} must have between 2 and ${cloneCap} clones`,
        );
      }
    }
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) {
      throw new EnvelopeError(`clone_forks missing successor_id: ${id}`);
    }
  }
}
