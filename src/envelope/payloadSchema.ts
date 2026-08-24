import { Type } from "typebox";
import type { TSchema } from "typebox/type";
import { Value } from "typebox/value";
import { EnvelopeError, type StageEnvelope } from "../types/envelope.js";

export type CompiledPayloadSchema = TSchema;

type JsonSchemaNode = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
};

function compileNode(node: unknown, path: string): TSchema {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`${path}: schema must be an object`);
  }

  const schema = node as JsonSchemaNode;
  if (typeof schema.type !== "string") {
    throw new Error(`${path}: type is required`);
  }

  switch (schema.type) {
    case "string":
      return Type.String();
    case "number":
      return Type.Number();
    case "integer":
      return Type.Integer();
    case "boolean":
      return Type.Boolean();
    case "array": {
      if (schema.items === undefined) {
        throw new Error(`${path}: array requires items`);
      }
      return Type.Array(compileNode(schema.items, `${path}.items`));
    }
    case "object": {
      const properties = schema.properties ?? {};
      if (
        properties === null ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      ) {
        throw new Error(`${path}: properties must be an object when present`);
      }

      const requiredList = schema.required ?? [];
      if (
        !Array.isArray(requiredList) ||
        !requiredList.every((k) => typeof k === "string")
      ) {
        throw new Error(
          `${path}: required must be an array of strings when present`,
        );
      }
      const required = new Set(requiredList as string[]);

      if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== "boolean"
      ) {
        throw new Error(
          `${path}: additionalProperties must be a boolean when present`,
        );
      }

      const compiledProps: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(
        properties as Record<string, unknown>,
      )) {
        const propSchema = compileNode(value, `${path}.properties.${key}`);
        compiledProps[key] = required.has(key)
          ? propSchema
          : Type.Optional(propSchema);
      }

      const options =
        schema.additionalProperties === false
          ? { additionalProperties: false as const }
          : undefined;
      return Type.Object(compiledProps, options);
    }
    default:
      throw new Error(
        `${path}: unsupported type "${schema.type}" (supported: object, string, number, integer, boolean, array)`,
      );
  }
}

/**
 * Compile a JSON Schema subset used for stage payload_schema.
 * Supported: type object/string/number/integer/boolean/array,
 * properties, required, items, additionalProperties (boolean).
 */
export function compilePayloadSchema(raw: unknown): CompiledPayloadSchema {
  const compiled = compileNode(raw, "payload_schema");
  if (!Type.IsObject(compiled)) {
    throw new Error("payload_schema: root type must be object");
  }
  return compiled;
}

export function assertEnvelopePayload(
  envelope: StageEnvelope,
  payloadSchema: unknown | undefined,
): void {
  if (payloadSchema === undefined) {
    return;
  }
  if (envelope.status !== "success") {
    return;
  }

  const schema = compilePayloadSchema(payloadSchema);
  if (envelope.payload === undefined) {
    throw new EnvelopeError("payload is required by stage payload_schema");
  }
  if (!Value.Check(schema, envelope.payload)) {
    const details = [...Value.Errors(schema, envelope.payload)]
      .map((err) => `${err.instancePath || "/"} ${err.message}`)
      .join("; ");
    throw new EnvelopeError(
      details
        ? `payload does not match payload_schema: ${details}`
        : "payload does not match payload_schema",
    );
  }
}
