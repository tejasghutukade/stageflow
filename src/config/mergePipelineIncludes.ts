import path from "node:path";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import { readYamlObject } from "./readYamlObject.js";

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
): Promise<LoadOutcome<{ entries: RawMergedEntry[]; pipelineId: string }>> {
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
  const idLocations = new Map<string, string>();
  const entries: RawMergedEntry[] = [];

  const mergeResult = await visitPipelineFile(absRoot, [], idLocations, entries);
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

  return loadSuccess({ entries, pipelineId });
}
