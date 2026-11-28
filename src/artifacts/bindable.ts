import { scrubSecrets } from "../compaction/scrub.js";
import type { FunctionDefinition } from "../config/loadFunction.js";
import { readFunctionDefinitionSync } from "../functions/toolPolicy.js";
import { readOnlyFailure } from "./bindings.js";

export const MAX_BINDABLE_FUNCTIONS = 20;

export type BindableFunctionInfo = {
  id: string;
  description: string;
  input: string;
  output: string;
};

export function bindableFunctionsFromAttachments(
  projectRoot: string,
  attachments: readonly { id: string }[],
): BindableFunctionInfo[] {
  const seen = new Set<string>();
  const rows: BindableFunctionInfo[] = [];
  const ids = attachments.map((attachment) => attachment.id).filter((id) => id.length > 0).sort();
  for (const id of ids) {
    if (seen.has(id) || rows.length >= MAX_BINDABLE_FUNCTIONS) continue;
    seen.add(id);
    const definition = readFunctionDefinitionSync(projectRoot, id);
    if (!isBindable(definition)) continue;
    rows.push(describeFunction(definition));
  }
  return rows;
}

export function isBindable(definition: FunctionDefinition | undefined): definition is FunctionDefinition {
  if (!definition || definition.kind !== "tool") return false;
  return readOnlyFailure(definition) === undefined;
}

function describeFunction(definition: FunctionDefinition): BindableFunctionInfo {
  const description = scrubSecrets(definition.tool_description || definition.description || definition.id);
  return {
    id: definition.id,
    description,
    input: compactInput(definition.input_schema),
    output: compactOutput(definition.output_schema),
  };
}

function compactInput(schema: Record<string, unknown> | undefined): string {
  const properties = asRecord(schema?.properties);
  if (!properties) return "input schema not declared";
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item) => typeof item === "string") : []);
  const parts = Object.keys(properties)
    .sort()
    .map((key) => {
      const type = asRecord(properties[key])?.type;
      const rendered = typeof type === "string" ? type : "any";
      return `${key}${required.has(key) ? "" : "?"}: ${rendered}`;
    });
  return `{${parts.join(", ")}}`;
}

function compactOutput(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "output schema not declared";
  const names = collectOutput(schema, "").sort();
  if (names.length === 0) return "output schema not declared";
  const text = names.join(", ");
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function collectOutput(schema: Record<string, unknown>, prefix: string): string[] {
  if (schema.type === "array") {
    const items = asRecord(schema.items);
    if (!items) return prefix ? [`${prefix}[]`] : [];
    return collectOutput(items, prefix ? `${prefix}[]` : "[]");
  }
  const properties = asRecord(schema.properties);
  if (!properties) return prefix ? [prefix] : [];
  const names: string[] = [];
  for (const key of Object.keys(properties).sort()) {
    const child = asRecord(properties[key]);
    const path = prefix ? `${prefix}.${key}` : key;
    if (!child) {
      names.push(path);
      continue;
    }
    if (child.type === "object" || child.type === "array") {
      const nested = collectOutput(child, path);
      names.push(...(nested.length > 0 ? nested : [path]));
      continue;
    }
    names.push(path);
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}
