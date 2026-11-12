import {
  accessFromCapabilities,
  deriveAccess,
  describeDeclaration,
  readAccessDeclaration,
  writeAccessDeclaration,
  type FunctionAccessDeclaration,
} from "@stageflow/function-access";
import type { FunctionBinding, FunctionCapability, FunctionDefinition, FunctionKind } from "../../api/functions";

export type DeclaredAccessState =
  | { mode: "declared"; access: FunctionAccessDeclaration }
  | { mode: "invalid"; issues: Array<{ message: string; line: number; column: number }> }
  | { mode: "insert" }
  | { mode: "legacy" };

export function declaredAccessState(source: string, capabilities: readonly FunctionCapability[]): DeclaredAccessState {
  const read = readAccessDeclaration(source);
  if (read.present && read.ok) return { mode: "declared", access: read.access };
  if (read.present) return { mode: "invalid", issues: read.issues };
  if (capabilities.length === 0) return { mode: "insert" };
  return { mode: "legacy" };
}

export function emptyDeclaredAccess(): FunctionAccessDeclaration {
  return { artifacts: "none", workspace: "none", files: [], env: [], network: [] };
}

export function accessSummary(access: FunctionAccessDeclaration): string {
  const labels = describeDeclaration(access);
  if (labels.length === 0) return "No access. This function can only work on its context.";
  return labels.join(" · ");
}

export function applyDeclaredControl(source: string, access: FunctionAccessDeclaration): string {
  const read = readAccessDeclaration(source);
  if (read.present && !read.ok) return source;
  return writeAccessDeclaration(source, access);
}

export function moveLegacyAccessIntoSource(
  source: string,
  capabilities: readonly FunctionCapability[],
  bindings: readonly FunctionBinding[],
): string {
  return writeAccessDeclaration(source, accessFromCapabilities(capabilities, bindings));
}

export function contractSnapshot(
  source: string,
  kind: FunctionKind,
  capabilities: readonly FunctionCapability[],
  bindings: readonly FunctionBinding[],
): { capabilities: unknown[]; bindings: unknown[] } {
  const read = readAccessDeclaration(source);
  if (read.present && read.ok) return deriveAccess(read.access, kind);
  return { capabilities: [...capabilities], bindings: [...bindings] };
}

export function definitionPayload(definition: FunctionDefinition): FunctionDefinition {
  const read = readAccessDeclaration(definition.source);
  if (!read.present || !read.ok) return definition;
  const { capabilities, bindings, ...rest } = definition;
  void capabilities;
  void bindings;
  return rest as FunctionDefinition;
}
