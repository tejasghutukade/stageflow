import {
  STAGE_GATE_KINDS,
  type StageConfig,
  type StageGateKind,
} from "../types/stage.js";
import { compilePayloadSchema } from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { readYamlObject } from "./readYamlObject.js";

function isGateKind(value: string): value is StageGateKind {
  return (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function parseGateKinds(
  raw: unknown,
  filePath: string,
): LoadOutcome<StageGateKind[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return loadFailure([
      {
        code: "stage.invalid_gate_kinds",
        message: `Invalid stage file ${filePath}: gate_kinds must be an array of strings`,
        category: "stage",
      },
    ]);
  }
  const kinds: StageGateKind[] = [];
  for (const item of raw) {
    if (!isGateKind(item)) {
      return loadFailure([
        {
          code: "stage.invalid_gate_kinds",
          message: `Invalid stage file ${filePath}: unsupported gate kind "${item}" (allowed: ${STAGE_GATE_KINDS.join(", ")})`,
          category: "stage",
        },
      ]);
    }
    kinds.push(item);
  }
  return loadSuccess(kinds.length > 0 ? kinds : undefined);
}

export async function loadStageOutcome(filePath: string): Promise<LoadOutcome<StageConfig>> {
  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "stage.load_error",
        message,
        category: "stage",
      },
    ]);
  }

  if (
    typeof raw?.id !== "string" ||
    typeof raw?.system_prompt !== "string" ||
    typeof raw?.model !== "string"
  ) {
    return loadFailure([
      {
        code: "stage.invalid_shape",
        message: `Invalid stage file ${filePath}: id, system_prompt, and model are required strings`,
        category: "stage",
        stageId: typeof raw?.id === "string" ? raw.id : undefined,
      },
    ]);
  }

  const stage: StageConfig = {
    id: raw.id,
    system_prompt: raw.system_prompt,
    model: raw.model,
  };

  if (raw.payload_schema !== undefined) {
    if (
      raw.payload_schema === null ||
      typeof raw.payload_schema !== "object" ||
      Array.isArray(raw.payload_schema)
    ) {
      return loadFailure([
        {
          code: "stage.invalid_payload_schema",
          message: `Invalid stage file ${filePath}: payload_schema must be an object`,
          category: "stage",
          stageId: raw.id,
        },
      ]);
    }
    try {
      compilePayloadSchema(raw.payload_schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return loadFailure([
        {
          code: "stage.invalid_payload_schema",
          message: `Invalid stage file ${filePath}: invalid payload_schema: ${message}`,
          category: "stage",
          stageId: raw.id,
        },
      ]);
    }
    stage.payload_schema = raw.payload_schema;
  }

  const gateKindsOutcome = parseGateKinds(raw.gate_kinds, filePath);
  if (!gateKindsOutcome.ok) {
    const issues: LoadIssue[] = gateKindsOutcome.issues.map((issue) => ({
      ...issue,
      stageId: stage.id,
    }));
    return loadFailure(issues);
  }
  if (gateKindsOutcome.value) stage.gate_kinds = gateKindsOutcome.value;

  if (raw.skill !== undefined) {
    if (typeof raw.skill !== "string" || raw.skill.trim() === "") {
      return loadFailure([
        {
          code: "stage.invalid_skill",
          message: `Invalid stage file ${filePath}: skill must be a non-empty string`,
          category: "stage",
          stageId: stage.id,
        },
      ]);
    }
    stage.skill = raw.skill.trim();
  }

  return loadSuccess(stage);
}

export async function loadStage(filePath: string): Promise<StageConfig> {
  const outcome = await loadStageOutcome(filePath);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
