import path from "node:path";
import { parseAgentField } from "../agent/agentBackend.js";
import type { PayloadSchemaMap } from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { parseModelField } from "./modelField.js";
import { readYamlObject } from "./readYamlObject.js";
import {
  classifyYamlDocument,
  dialectWarningForDocument,
  mixedDialectIssue,
} from "./yamlDialect.js";

export type RawMergedEntry = {
  raw: unknown;
  declaringPath: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function formatIncludeCycle(stack: string[], nextPath: string): string {
  const chain = [...stack, nextPath].map((p) => path.basename(p));
  return chain.join(" → ");
}

async function visitPipelineFile(
  filePath: string,
  stack: string[],
  idLocations: Map<string, string>,
  entries: RawMergedEntry[],
  warnings: LoadIssue[],
): Promise<LoadOutcome<void>> {
  const absPath = normalizePath(filePath);

  if (stack.some((p) => normalizePath(p) === absPath)) {
    const cycleChain = formatIncludeCycle(stack, absPath);
    return loadFailure([
      {
        code: "pipeline.include_cycle",
        message: `Include cycle detected: ${cycleChain}`,
        category: "pipeline",
      },
    ]);
  }

  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(absPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "pipeline.load_error",
        message,
        category: "pipeline",
      },
    ]);
  }

  const dialect = classifyYamlDocument(raw);
  if (dialect === "invalid") {
    return loadFailure([mixedDialectIssue()]);
  }
  const warning = dialectWarningForDocument(raw, absPath);
  if (warning) warnings.push(warning);

  const isFragment = stack.length > 0;
  if (isFragment && raw.schemas !== undefined) {
    return loadFailure([
      {
        code: "pipeline.include_invalid",
        message: `Invalid include in ${absPath}: schemas is only allowed on the pipeline file, not on include fragments`,
        category: "pipeline",
      },
    ]);
  }

  const nextStack = [...stack, absPath];

  if (raw.include !== undefined) {
    if (!Array.isArray(raw.include)) {
      return loadFailure([
        {
          code: "pipeline.include_invalid",
          message: `Invalid include in ${absPath}: include must be an array`,
          category: "pipeline",
        },
      ]);
    }

    for (let index = 0; index < raw.include.length; index++) {
      const item = raw.include[index];
      if (!isPlainObject(item) || typeof item.local !== "string" || !item.local) {
        return loadFailure([
          {
            code: "pipeline.include_invalid",
            message: `Invalid include entry at index ${index} in ${absPath}: expected { local: "<path>" }`,
            category: "pipeline",
          },
        ]);
      }

      const includePath = normalizePath(path.resolve(path.dirname(absPath), item.local));
      const includeResult = await visitPipelineFile(
        includePath,
        nextStack,
        idLocations,
        entries,
        warnings,
      );
      if (!includeResult.ok) return includeResult;
    }
  }

  if (Array.isArray(raw.stages)) {
    for (const entry of raw.stages) {
      if (isPlainObject(entry)) {
        const entryId = typeof entry.id === "string" ? entry.id : undefined;
        if (entryId) {
          const priorPath = idLocations.get(entryId);
          if (priorPath) {
            return loadFailure([
              {
                code: "pipeline.include_duplicate_stage",
                message: `Duplicate stage id "${entryId}" in ${absPath} (also declared in ${priorPath})`,
                category: "pipeline",
              },
            ]);
          }
          idLocations.set(entryId, absPath);
        }
      }

      entries.push({ raw: entry, declaringPath: absPath });
    }
  }

  return loadSuccess(undefined);
}

export async function mergePipelineStages(
  rootPath: string,
): Promise<
  LoadOutcome<{
    entries: RawMergedEntry[];
    pipelineId: string;
    agent?: string;
    model?: string;
    schemas?: PayloadSchemaMap;
    warnings: LoadIssue[];
  }>
> {
  const absRoot = normalizePath(rootPath);

  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(absRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "pipeline.load_error",
        message,
        category: "pipeline",
      },
    ]);
  }

  if (typeof raw.id !== "string" || !raw.id) {
    return loadFailure([
      {
        code: "pipeline.invalid_shape",
        message: `Invalid pipeline ${absRoot}: id is required`,
        category: "pipeline",
      },
    ]);
  }

  if (!Array.isArray(raw.stages)) {
    return loadFailure([
      {
        code: "pipeline.invalid_shape",
        message: `Invalid pipeline ${absRoot}: stages[] is required`,
        category: "pipeline",
      },
    ]);
  }

  const pipelineId = raw.id;

  const agentField = parseAgentField(raw.agent);
  if (!agentField.ok) {
    return loadFailure([
      {
        code: "pipeline.invalid_agent",
        message: `Invalid pipeline ${absRoot}: ${agentField.message}`,
        category: "pipeline",
        pipelineId,
      },
    ]);
  }
  const agent = agentField.value;

  const modelField = parseModelField(raw.model);
  if (!modelField.ok) {
    return loadFailure([
      {
        code: "pipeline.invalid_model",
        message: `Invalid pipeline ${absRoot}: ${modelField.message}`,
        category: "pipeline",
        pipelineId,
      },
    ]);
  }
  const model = modelField.value;

  const schemasOutcome = parsePipelineSchemas(raw.schemas, absRoot, pipelineId);
  if (!schemasOutcome.ok) return schemasOutcome;
  const schemas = schemasOutcome.value;

  const idLocations = new Map<string, string>();
  const entries: RawMergedEntry[] = [];
  const warnings: LoadIssue[] = [];

  const mergeResult = await visitPipelineFile(absRoot, [], idLocations, entries, warnings);
  if (!mergeResult.ok) return mergeResult;

  if (entries.length === 0) {
    return loadFailure([
      {
        code: "pipeline.invalid_shape",
        message: `Invalid pipeline ${absRoot}: stages must be non-empty`,
        category: "pipeline",
      },
    ]);
  }

  return loadSuccess({
    entries,
    pipelineId,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(schemas !== undefined ? { schemas } : {}),
    warnings,
  });
}

function parsePipelineSchemas(
  raw: unknown,
  absPath: string,
  pipelineId: string,
): LoadOutcome<PayloadSchemaMap | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!isPlainObject(raw)) {
    return loadFailure([
      {
        code: "pipeline.invalid_shape",
        message: `Invalid pipeline ${absPath}: schemas must be an object`,
        category: "pipeline",
        pipelineId,
      },
    ]);
  }
  const schemas: PayloadSchemaMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return loadFailure([
        {
          code: "pipeline.invalid_shape",
          message: `Invalid pipeline ${absPath}: schemas.${name} must be an object`,
          category: "pipeline",
          pipelineId,
        },
      ]);
    }
    schemas[name] = value;
  }
  return loadSuccess(schemas);
}
