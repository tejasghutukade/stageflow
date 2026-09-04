import type { CompletionContract } from "../types/completion.js";
import type { StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

function failure(stageId: string, message: string): LoadOutcome<void> {
  return loadFailure([
    {
      code: "pipeline.invalid_completion",
      message: `Stage "${stageId}" completion: ${message}`,
      category: "pipeline",
    },
  ]);
}

function isRequiredStringArrayField(schema: unknown, field: string): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const root = schema as Record<string, unknown>;
  if (!Array.isArray(root.required) || !root.required.includes(field)) return false;
  if (!root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    return false;
  }
  const property = (root.properties as Record<string, unknown>)[field];
  if (!property || typeof property !== "object" || Array.isArray(property)) return false;
  const arraySchema = property as Record<string, unknown>;
  if (arraySchema.type !== "array") return false;
  const items = arraySchema.items;
  return Boolean(
    items &&
      typeof items === "object" &&
      !Array.isArray(items) &&
      (items as Record<string, unknown>).type === "string",
  );
}

export function validateCompletionContractForStage(
  stage: StageConfig,
  completion: CompletionContract | undefined,
): LoadOutcome<void> {
  if (!completion) return loadSuccess(undefined);
  for (const check of completion.checks) {
    if (check.type === "payload_schema" && stage.payload_schema === undefined) {
      return failure(stage.id, `check "${check.id}" requires the stage to declare payload_schema`);
    }
    if (
      check.type === "gate" &&
      !stage.gate_kinds?.includes(check.kind)
    ) {
      return failure(
        stage.id,
        `gate check "${check.id}" requires gate_kinds to include "${check.kind}"`,
      );
    }
    if (check.type === "checkout_changes") {
      for (const field of check.path_fields ?? []) {
        if (!isRequiredStringArrayField(stage.payload_schema, field)) {
          return failure(
            stage.id,
            `checkout check "${check.id}" path field "${field}" must be a required array of strings in payload_schema`,
          );
        }
      }
    }
  }
  return loadSuccess(undefined);
}
