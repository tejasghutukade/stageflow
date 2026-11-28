import { ARTIFACT_ID_PATTERN } from "../artifacts/keys.js";
import type { StageArtifactsConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

export const STAGE_ARTIFACT_EXPECT_MAX = 20;

const ALLOWED_KEYS = new Set(["publish", "expect"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(label: string, stageId: string | undefined, message: string): LoadOutcome<never> {
  return loadFailure([
    {
      code: "stage.invalid_artifacts",
      message: `Invalid stage ${label}: artifacts ${message}`,
      category: "stage",
      ...(stageId !== undefined ? { stageId } : {}),
    },
  ]);
}

/**
 * Stage body `artifacts:`. `undefined` raw, or `publish: false` with no other
 * keys, yields `undefined` so the loaded stage matches a stage that omitted the block.
 */
export function parseStageArtifacts(
  raw: unknown,
  label: string,
  stageId?: string,
): LoadOutcome<StageArtifactsConfig | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!isPlainObject(raw)) {
    return fail(label, stageId, "must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return fail(label, stageId, `unknown key "${key}" (allowed: publish, expect)`);
    }
  }
  if (raw.publish !== undefined && typeof raw.publish !== "boolean") {
    return fail(label, stageId, "publish must be a boolean");
  }
  const publish = raw.publish === true;
  if (raw.expect !== undefined && !publish) {
    return fail(label, stageId, "expect requires publish: true");
  }
  if (!publish) return loadSuccess(undefined);
  if (raw.expect === undefined) return loadSuccess({ publish: true });
  if (!Array.isArray(raw.expect)) {
    return fail(label, stageId, "expect must be an array of artifact ids");
  }
  if (raw.expect.length > STAGE_ARTIFACT_EXPECT_MAX) {
    return fail(label, stageId, `expect lists at most ${STAGE_ARTIFACT_EXPECT_MAX} ids`);
  }
  const expect: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.expect) {
    if (typeof item !== "string" || !ARTIFACT_ID_PATTERN.test(item)) {
      return fail(
        label,
        stageId,
        `expect id ${JSON.stringify(item)} must match ${ARTIFACT_ID_PATTERN}`,
      );
    }
    if (seen.has(item)) {
      return fail(label, stageId, `expect id "${item}" is duplicated`);
    }
    seen.add(item);
    expect.push(item);
  }
  return loadSuccess(expect.length > 0 ? { publish: true, expect } : { publish: true });
}
