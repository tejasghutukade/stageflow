import { parse } from "yaml";

export type StageInputField = { name: string; required: boolean; type?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDoc(text: string): Record<string, unknown> | null {
  try {
    const doc = parse(text);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function resolveRef(schema: unknown, schemas: unknown): unknown {
  if (!isRecord(schema) || typeof schema.$ref !== "string") return schema;
  const match = /^#\/schemas\/(.+)$/.exec(schema.$ref);
  if (!match || !isRecord(schemas)) return undefined;
  return schemas[match[1] as string];
}

export function fieldsOfSchema(schema: unknown): StageInputField[] | null {
  if (!isRecord(schema) || !isRecord(schema.properties)) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);
  return Object.entries(schema.properties).map(([name, prop]) => {
    const type = isRecord(prop) && typeof prop.type === "string" ? prop.type : undefined;
    return { name, required: required.has(name), ...(type ? { type } : {}) };
  });
}

function inputSchemaOf(stage: unknown): unknown {
  if (!isRecord(stage) || !isRecord(stage.io) || !isRecord(stage.io.input)) return undefined;
  return stage.io.input.schema;
}

/**
 * The stage's `io.input.schema` top-level properties, read from the pipeline file and, for `uses:` stages,
 * the stage file. Returns null when the schema cannot be read (the dialog then runs in free mode).
 */
export function stageInputFields(opts: {
  stageId: string;
  pipelineYaml?: string;
  stageYaml?: string;
}): StageInputField[] | null {
  const pipeline = opts.pipelineYaml !== undefined ? parseDoc(opts.pipelineYaml) : null;
  const schemas = pipeline?.schemas;
  if (opts.stageYaml !== undefined) {
    const stage = parseDoc(opts.stageYaml);
    const fields = fieldsOfSchema(resolveRef(inputSchemaOf(stage), schemas));
    if (fields) return fields;
  }
  if (pipeline && Array.isArray(pipeline.stages)) {
    const entry = pipeline.stages.find((s) => isRecord(s) && s.id === opts.stageId);
    const fields = fieldsOfSchema(resolveRef(inputSchemaOf(entry), schemas));
    if (fields) return fields;
  }
  return null;
}
