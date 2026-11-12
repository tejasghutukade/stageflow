import { functionsApi, FunctionApiError, type FunctionDefinition, type FunctionDetail, type FunctionKind, type FunctionSummary } from "../../api/functions";

const ACCESS_NOTE = `  env: [],           // names; add "?" for optional, e.g. "MIN_SCORE?"
  network: [],       // allowed https origins
};

`;

export const FUNCTION_TEMPLATES: Record<FunctionKind, string> = {
  verification: `export const access = {
  artifacts: "none", // "none" | "read"
${ACCESS_NOTE}export default function execute(context) {
  return { passed: true, message: "Accepted" };
}
`,
  routing: `export const access = {
  artifacts: "none", // "none" | "read"
${ACCESS_NOTE}export default function execute(context) {
  return {
    nextStageIds: context.children.map((child) => child.id),
    reason: "Every eligible destination",
  };
}
`,
  tool: `export const access = {
  artifacts: "none", // "none" | "read" | "write" (write: tools only)
${ACCESS_NOTE}export default function execute(context) {
  const counts = Array.isArray(context.input.counts) ? context.input.counts : [];
  return { total: counts.reduce((sum, count) => sum + count, 0) };
}
`,
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

export function followToolFields(
  creating: boolean,
  kind: FunctionKind,
  fields: { id: string; description: string; tool_name: string; tool_description: string },
  touched: { toolName: boolean; toolDescription: boolean },
): { tool_name: string; tool_description: string } {
  if (!creating || kind !== "tool") {
    return { tool_name: fields.tool_name, tool_description: fields.tool_description };
  }
  return {
    tool_name: touched.toolName ? fields.tool_name : fields.id,
    tool_description: touched.toolDescription ? fields.tool_description : fields.description,
  };
}
