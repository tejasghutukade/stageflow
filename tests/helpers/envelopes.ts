import type { StageEnvelope } from "../../src/types/envelope.js";

export function okEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "success", summary, artifacts: [], payload: {}, ...extra };
}

export function failEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "failure", summary, artifacts: [], ...extra };
}
