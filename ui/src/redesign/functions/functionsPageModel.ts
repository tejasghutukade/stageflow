import { functionsApi, FunctionApiError, type FunctionDefinition, type FunctionDetail, type FunctionKind, type FunctionSummary } from "../../api/functions";

export const FUNCTION_TEMPLATES: Record<FunctionKind, string> = {
  verification: "export default function execute(context) {\n  return { passed: true, message: \"Accepted\" };\n}\n",
  routing:
    "export default function execute(context) {\n  return {\n    nextStageIds: context.children.map((child) => child.id),\n    reason: \"Every eligible destination\",\n  };\n}\n",
  tool: "export default function execute(context) {\n  const counts = Array.isArray(context.input.counts) ? context.input.counts : [];\n  return { total: counts.reduce((sum, count) => sum + count, 0) };\n}\n",
};

export function testRequestBody(input: { source?: string; input?: unknown; mocks?: unknown; real: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.source !== undefined) body.source = input.source;
  if (input.input !== undefined) body.input = input.input;
  if (input.mocks !== undefined) body.mocks = input.mocks;
  if (input.real) body.real = true;
  return body;
}

export async function deleteUnreferenced(
  id: string,
  confirmed: boolean,
): Promise<{ confirm: true } | { functions: FunctionSummary[] }> {
  if (!confirmed) return { confirm: true };
  await functionsApi.remove(id);
  return { functions: await functionsApi.list() };
}

export async function saveOrSurfaceConflict(
  id: string,
  baseRevision: number,
  definition: unknown,
): Promise<
  | { ok: true; detail: FunctionDetail }
  | { ok: false; kind: "invalid"; revision: number; issues: FunctionApiError["issues"] }
  | { ok: false; kind: "conflict"; detail: FunctionDetail }
> {
  try {
    return { ok: true, detail: await functionsApi.save(id, { baseRevision, definition }) };
  } catch (error) {
    if (!(error instanceof FunctionApiError)) throw error;
    if (error.code === "function.conflict") {
      return { ok: false, kind: "conflict", detail: await functionsApi.get(id) };
    }
    return { ok: false, kind: "invalid", revision: baseRevision, issues: error.issues };
  }
}

export function definitionFromDetail(detail: FunctionDetail): FunctionDefinition | null {
  return detail.definition;
}
