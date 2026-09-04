import { parseCloneForks } from "./check.js";
import { assertCloneAssignmentPayload } from "./payloadSchema.js";
import { EnvelopeError } from "../types/envelope.js";
import { CLONE_ACTIONS, type CloneEmitContext, type CloneForkItem } from "../types/forkChoice.js";

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

  for (const [i, item] of items.entries()) {
    const itemPath = `clone_forks[${i}]`;
    if (seen.has(item.successor_id)) {
      throw new EnvelopeError(
        `${itemPath} contains duplicate successor_id: ${item.successor_id}`,
      );
    }
    if (!expectedSet.has(item.successor_id)) {
      throw new EnvelopeError(
        `${itemPath} contains extra successor_id: ${item.successor_id}`,
      );
    }
    seen.add(item.successor_id);

    const capEntry = cloneEmitContext.clonableSuccessors.find(
      (s) => s.successorId === item.successor_id,
    );
    const cloneCap = capEntry?.cloneCap;
    const allowedActions = cloneEmitContext.allowedActions ?? [...CLONE_ACTIONS];
    if (!allowedActions.includes(item.action)) {
      throw new EnvelopeError(
        `${itemPath} action "${item.action}" is not allowed for ${item.successor_id} (allowed: ${allowedActions.join(", ")})`,
      );
    }

    if (item.action === "skip") {
      if (
        fieldPresent(item, "envelope") ||
        fieldPresent(item, "mode") ||
        fieldPresent(item, "clones")
      ) {
        throw new EnvelopeError(
          `${itemPath} skip for ${item.successor_id} must not include envelope, mode, or clones`,
        );
      }
    } else if (item.action === "once") {
      if (!fieldPresent(item, "envelope")) {
        throw new EnvelopeError(
          `${itemPath} once for ${item.successor_id} requires envelope`,
        );
      }
      if (fieldPresent(item, "mode") || fieldPresent(item, "clones")) {
        throw new EnvelopeError(
          `${itemPath} once for ${item.successor_id} must not include mode or clones`,
        );
      }
      if (capEntry?.cloneInputSchema !== undefined) {
        assertCloneAssignmentPayload(
          item.envelope,
          capEntry.cloneInputSchema,
          item.successor_id,
          `${itemPath}.envelope`,
        );
      }
    } else if (item.action === "fanout") {
      if (fieldPresent(item, "envelope")) {
        throw new EnvelopeError(
          `${itemPath} fanout for ${item.successor_id} must not include a top-level envelope`,
        );
      }
      if (!fieldPresent(item, "mode") || !fieldPresent(item, "clones") || item.clones === undefined) {
        throw new EnvelopeError(
          `${itemPath} fanout for ${item.successor_id} requires mode and clones`,
        );
      }
      if (cloneCap === undefined || item.clones.length < 2 || item.clones.length > cloneCap) {
        throw new EnvelopeError(
          `${itemPath} fanout for ${item.successor_id} must have between 2 and ${cloneCap} clones`,
        );
      }
      if (capEntry?.cloneInputSchema !== undefined) {
        for (const [j, clone] of item.clones.entries()) {
          assertCloneAssignmentPayload(
            clone.envelope,
            capEntry.cloneInputSchema,
            item.successor_id,
            `${itemPath}.clones[${j}].envelope`,
          );
        }
      }
    }
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) {
      throw new EnvelopeError(`clone_forks missing successor_id: ${id}`);
    }
  }
}
