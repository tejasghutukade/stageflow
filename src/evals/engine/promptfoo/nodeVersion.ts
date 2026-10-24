import semver from "semver";
import { EngineError } from "./errors.js";
import { MIN_NODE } from "./pinned.js";

export type NodeCheck = { ok: boolean; found: string; required: string };

export function checkNode(
  version: string = process.versions.node,
  min: string = MIN_NODE,
): NodeCheck {
  const found = semver.valid(version) ?? version;
  const ok = semver.valid(found) !== null && semver.gte(found, min);
  return { ok, found, required: min };
}

export function assertNode(
  version: string = process.versions.node,
  min: string = MIN_NODE,
): void {
  const res = checkNode(version, min);
  if (!res.ok) {
    throw new EngineError(
      "EVAL_NODE_TOO_OLD",
      `Evals need Node ${res.required} or newer; found ${res.found}.`,
    );
  }
}
