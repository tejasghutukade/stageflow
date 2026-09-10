import { Type } from "typebox";
import type { TSchema } from "typebox/type";
import { Value } from "typebox/value";
import { EnvelopeError, type StageEnvelope } from "../types/envelope.js";

export type CompiledPayloadSchema = TSchema;

export type PayloadSchemaMap = Record<string, unknown>;

export type CompilePayloadSchemaOptions = {
  schemas?: PayloadSchemaMap;
};

export class UnresolvedSchemaRefError extends Error {
  readonly ref: string;

  constructor(path: string, ref: string) {
    super(`${path}: unresolved $ref "${ref}"`);
    this.name = "UnresolvedSchemaRefError";
    this.ref = ref;
  }
}

const SCHEMA_REF_PREFIX = "#/schemas/";

type JsonSchemaNode = {
  $ref?: unknown;
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
  minItems?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  pattern?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  nullable?: unknown;
};

type CompileCtx = {
  schemas?: PayloadSchemaMap;
  stack: string[];
};

function readSchemaRefName(ref: unknown, path: string): string {
  if (typeof ref !== "string" || !ref.startsWith(SCHEMA_REF_PREFIX)) {
    throw new Error(
      `${path}: $ref must be a JSON Pointer of the form #/schemas/<name>`,
    );
  }
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  if (!name || name.includes("/")) {
    throw new Error(
      `${path}: $ref must be a JSON Pointer of the form #/schemas/<name>`,
    );
  }
  return name;
}

function derefSchemaNode(
  node: unknown,
  path: string,
  ctx: CompileCtx,
): { schema: JsonSchemaNode; stack: string[] } {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`${path}: schema must be an object`);
  }
  const schema = node as JsonSchemaNode;
  if (schema.$ref === undefined) {
    return { schema, stack: ctx.stack };
  }
  const name = readSchemaRefName(schema.$ref, path);
  if (ctx.stack.includes(name)) {
    const cycle = [...ctx.stack, name]
      .map((item) => `${SCHEMA_REF_PREFIX}${item}`)
      .join(" → ");
    throw new Error(`${path}: $ref cycle involving ${cycle}`);
  }
  const target = ctx.schemas?.[name];
  if (target === undefined) {
    throw new UnresolvedSchemaRefError(path, `${SCHEMA_REF_PREFIX}${name}`);
  }
  return derefSchemaNode(target, path, {
    schemas: ctx.schemas,
    stack: [...ctx.stack, name],
  });
}

function readEnum(
  schema: JsonSchemaNode,
  path: string,
  valueType: "string" | "integer",
): readonly (string | number)[] | undefined {
  if (schema.enum === undefined) {
    return undefined;
  }
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    throw new Error(`${path}: enum must be a non-empty array when present`);
  }
  if (valueType === "string") {
    if (!schema.enum.every((value) => typeof value === "string")) {
      throw new Error(`${path}: enum values must be strings`);
    }
    return schema.enum as string[];
  }
  if (
    !schema.enum.every(
      (value) => typeof value === "number" && Number.isInteger(value),
    )
  ) {
    throw new Error(`${path}: enum values must be integers`);
  }
  return schema.enum as number[];
}

function readBound(
  value: unknown,
  path: string,
  keyword: "minimum" | "maximum",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}: ${keyword} must be a number when present`);
  }
  return value;
}

function numericOptions(
  schema: JsonSchemaNode,
  path: string,
): { minimum?: number; maximum?: number } | undefined {
  const minimum = readBound(schema.minimum, path, "minimum");
  const maximum = readBound(schema.maximum, path, "maximum");
  if (minimum === undefined && maximum === undefined) {
    return undefined;
  }
  return {
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
}

function readPattern(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${path}: pattern must be a string when present`);
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, "u");
  } catch {
    throw new Error(`${path}: pattern must be a valid regular expression`);
  }
  return value;
}

function readNonNegativeInt(
  value: unknown,
  path: string,
  keyword: "minLength" | "maxLength",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `${path}: ${keyword} must be a non-negative integer when present`,
    );
  }
  return value;
}

function stringOptions(
  schema: JsonSchemaNode,
  path: string,
): { pattern?: string; minLength?: number; maxLength?: number } | undefined {
  const pattern = readPattern(schema.pattern, path);
  const minLength = readNonNegativeInt(schema.minLength, path, "minLength");
  const maxLength = readNonNegativeInt(schema.maxLength, path, "maxLength");
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  ) {
    throw new Error(`${path}: minLength must be <= maxLength`);
  }
  if (pattern === undefined && minLength === undefined && maxLength === undefined) {
    return undefined;
  }
  return {
    ...(pattern !== undefined ? { pattern } : {}),
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
  };
}

function compileNode(node: unknown, path: string, ctx: CompileCtx): TSchema {
  const { schema, stack } = derefSchemaNode(node, path, ctx);
  const childCtx: CompileCtx = { schemas: ctx.schemas, stack };
  if (typeof schema.type !== "string") {
    throw new Error(`${path}: type is required`);
  }

  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    throw new Error(`${path}: nullable must be a boolean when present`);
  }
  const nullable = schema.nullable === true;

  let base: TSchema;
  switch (schema.type) {
    case "string": {
      const enumerated = readEnum(schema, path, "string");
      const opts = stringOptions(schema, path);
      base =
        enumerated !== undefined
          ? Type.Enum(enumerated as string[], opts)
          : opts !== undefined
            ? Type.String(opts)
            : Type.String();
      break;
    }
    case "number": {
      const options = numericOptions(schema, path);
      base = options !== undefined ? Type.Number(options) : Type.Number();
      break;
    }
    case "integer": {
      const enumerated = readEnum(schema, path, "integer");
      const options = numericOptions(schema, path);
      if (enumerated !== undefined) {
        base = Type.Enum(enumerated as number[], options);
      } else {
        base = options !== undefined ? Type.Integer(options) : Type.Integer();
      }
      break;
    }
    case "boolean":
      base = Type.Boolean();
      break;
    case "array": {
      if (schema.items === undefined) {
        throw new Error(`${path}: array requires items`);
      }
      if (
        schema.minItems !== undefined &&
        (typeof schema.minItems !== "number" ||
          !Number.isInteger(schema.minItems) ||
          schema.minItems < 0)
      ) {
        throw new Error(
          `${path}: minItems must be a non-negative integer when present`,
        );
      }
      const items = compileNode(schema.items, `${path}.items`, childCtx);
      base =
        schema.minItems !== undefined
          ? Type.Array(items, { minItems: schema.minItems })
          : Type.Array(items);
      break;
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
        const propSchema = compileNode(value, `${path}.properties.${key}`, childCtx);
        compiledProps[key] = required.has(key)
          ? propSchema
          : Type.Optional(propSchema);
      }

      const options =
        schema.additionalProperties === false
          ? { additionalProperties: false as const }
          : undefined;
      base = Type.Object(compiledProps, options);
      break;
    }
    default:
      throw new Error(
        `${path}: unsupported type "${schema.type}" (supported: object, string, number, integer, boolean, array)`,
      );
  }

  return nullable ? Type.Union([base, Type.Null()]) : base;
}

/**
 * Compile a JSON Schema subset for IR `payload_schema` / `clone_input_schema`
 * (YAML: `io.output.schema` / `io.input.schema`).
 * Supported: type object/string/number/integer/boolean/array,
 * properties, required, items, additionalProperties (boolean),
 * minItems, enum, minimum, maximum. String nodes also accept
 * pattern (a JS RegExp validated with the unicode flag), minLength,
 * and maxLength (non-negative integers). Nested nodes accept
 * nullable (boolean), compiling to a union of that type with null;
 * the root object cannot be nullable. `$ref` is resolved against
 * `options.schemas` using JSON Pointer `#/schemas/<name>`. Unknown
 * keywords other than `$ref` are ignored.
 */
export function compilePayloadSchema(
  raw: unknown,
  options?: CompilePayloadSchemaOptions,
): CompiledPayloadSchema {
  const ctx: CompileCtx = { schemas: options?.schemas, stack: [] };
  const { schema: resolved } = derefSchemaNode(raw, "payload_schema", ctx);
  if (resolved.nullable === true) {
    throw new Error("payload_schema: root cannot be nullable");
  }
  const compiled = compileNode(raw, "payload_schema", ctx);
  if (!Type.IsObject(compiled)) {
    throw new Error("payload_schema: root type must be object");
  }
  return compiled;
}

function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredKeys(schema: JsonSchemaNode): string[] {
  if (schema.required === undefined) return [];
  if (
    !Array.isArray(schema.required) ||
    !schema.required.every((key) => typeof key === "string")
  ) {
    return [];
  }
  return schema.required as string[];
}

function readProperties(schema: JsonSchemaNode): Record<string, unknown> {
  if (!isPlainSchemaObject(schema.properties)) return {};
  return schema.properties as Record<string, unknown>;
}

function typesCompatible(consumerType: string, producerType: string): boolean {
  if (consumerType === producerType) return true;
  return consumerType === "number" && producerType === "integer";
}

function readEnumValues(schema: JsonSchemaNode): readonly unknown[] | undefined {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return undefined;
  return schema.enum;
}

function enumCompatible(
  consumer: JsonSchemaNode,
  producer: JsonSchemaNode,
  type: string,
): boolean {
  if (type !== "string" && type !== "integer") return true;
  const consumerEnum = readEnumValues(consumer);
  const producerEnum = readEnumValues(producer);
  if (consumerEnum === undefined) return true;
  if (producerEnum === undefined) return false;
  const allowed = new Set(consumerEnum);
  return producerEnum.every((value) => allowed.has(value));
}

function patternCompatible(consumer: JsonSchemaNode, producer: JsonSchemaNode): boolean {
  const consumerPattern =
    typeof consumer.pattern === "string" ? consumer.pattern : undefined;
  const producerPattern =
    typeof producer.pattern === "string" ? producer.pattern : undefined;
  if (consumerPattern === undefined) return true;
  if (producerPattern === undefined) return false;
  return consumerPattern === producerPattern;
}

function numericBound(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function minBoundFits(consumerBound: unknown, producerBound: unknown): boolean {
  const consumer = numericBound(consumerBound);
  if (consumer === undefined) return true;
  const producer = numericBound(producerBound);
  if (producer === undefined) return false;
  return producer >= consumer;
}

function maxBoundFits(consumerBound: unknown, producerBound: unknown): boolean {
  const consumer = numericBound(consumerBound);
  if (consumer === undefined) return true;
  const producer = numericBound(producerBound);
  if (producer === undefined) return false;
  return producer <= consumer;
}

function isSubsetNode(
  consumer: unknown,
  producer: unknown,
  path: string,
  ctx: CompileCtx,
): boolean {
  const consumerDeref = derefSchemaNode(consumer, path, ctx);
  const producerDeref = derefSchemaNode(producer, path, ctx);
  const consumerNode = consumerDeref.schema;
  const producerNode = producerDeref.schema;
  if (typeof consumerNode.type !== "string" || typeof producerNode.type !== "string") {
    return false;
  }
  if (!typesCompatible(consumerNode.type, producerNode.type)) {
    return false;
  }

  if (producerNode.nullable === true && consumerNode.nullable !== true) {
    return false;
  }

  if (consumerNode.type === "array") {
    if (consumerNode.items === undefined || producerNode.items === undefined) {
      return false;
    }
    if (
      !isSubsetNode(consumerNode.items, producerNode.items, `${path}.items`, {
        schemas: ctx.schemas,
        stack: consumerDeref.stack,
      })
    ) {
      return false;
    }
    return minBoundFits(consumerNode.minItems, producerNode.minItems);
  }

  if (consumerNode.type === "object") {
    const consumerRequired = readRequiredKeys(consumerNode);
    const producerRequired = new Set(readRequiredKeys(producerNode));
    const producerProps = readProperties(producerNode);
    const consumerProps = readProperties(consumerNode);

    for (const key of consumerRequired) {
      if (!(key in producerProps) || !producerRequired.has(key)) {
        return false;
      }
    }

    for (const [key, consumerProp] of Object.entries(consumerProps)) {
      if (producerProps[key] === undefined) continue;
      if (
        !isSubsetNode(consumerProp, producerProps[key], `${path}.properties.${key}`, {
          schemas: ctx.schemas,
          stack: consumerDeref.stack,
        })
      ) {
        return false;
      }
    }

    if (consumerNode.additionalProperties === false) {
      if (producerNode.additionalProperties !== false) {
        return false;
      }
      for (const key of Object.keys(producerProps)) {
        if (!(key in consumerProps)) {
          return false;
        }
      }
    }

    return true;
  }

  if (!enumCompatible(consumerNode, producerNode, consumerNode.type)) {
    return false;
  }

  if (consumerNode.type === "string") {
    if (!patternCompatible(consumerNode, producerNode)) return false;
    if (!minBoundFits(consumerNode.minLength, producerNode.minLength)) return false;
    if (!maxBoundFits(consumerNode.maxLength, producerNode.maxLength)) return false;
  }

  if (consumerNode.type === "number" || consumerNode.type === "integer") {
    if (!minBoundFits(consumerNode.minimum, producerNode.minimum)) return false;
    if (!maxBoundFits(consumerNode.maximum, producerNode.maximum)) return false;
  }

  return true;
}

/**
 * After `$ref` resolve, true when every success payload that satisfies the
 * producer schema also satisfies the consumer schema (producer output
 * assignable to consumer input). Extra producer fields are allowed unless
 * the consumer sets `additionalProperties: false`, which also requires the
 * producer to close extras. A number consumer accepts an integer producer;
 * the reverse is incompatible. Producer enums must be subsets of consumer
 * enums; a consumer enum with an unconstrained producer is incompatible.
 * String `pattern` values must be identical when the consumer sets one.
 * Producer `minimum`/`maximum`, `minLength`/`maxLength`, and array `minItems`
 * must fit inside the consumer bounds (a consumer bound with an omitted
 * producer bound is incompatible). A nullable producer is incompatible unless
 * the consumer is also nullable.
 */
export function isPayloadSchemaSubset(
  consumer: unknown,
  producer: unknown,
  options?: CompilePayloadSchemaOptions,
): boolean {
  return isSubsetNode(consumer, producer, "payload_schema", {
    schemas: options?.schemas,
    stack: [],
  });
}

export function expandPayloadSchemaRefs(
  raw: unknown,
  options?: CompilePayloadSchemaOptions,
): unknown {
  return expandSchemaNode(raw, "payload_schema", {
    schemas: options?.schemas,
    stack: [],
  });
}

function expandSchemaNode(node: unknown, path: string, ctx: CompileCtx): unknown {
  const { schema, stack } = derefSchemaNode(node, path, ctx);
  const childCtx: CompileCtx = { schemas: ctx.schemas, stack };
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") continue;
    if (key === "properties" && isPlainSchemaObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value)) {
        props[pk] = expandSchemaNode(pv, `${path}.properties.${pk}`, childCtx);
      }
      clone.properties = props;
      continue;
    }
    if (key === "items") {
      clone.items = expandSchemaNode(value, `${path}.items`, childCtx);
      continue;
    }
    clone[key] = value;
  }
  return clone;
}

function formatPayloadInstancePath(instancePath: string): string {
  const translated = instancePath.replace(/\//g, ".").replace(/^\./, "");
  return translated ? `payload.${translated}` : "payload";
}

function payloadSchemaMismatchDetails(
  schema: CompiledPayloadSchema,
  payload: unknown,
): string {
  return [...Value.Errors(schema, payload)]
    .map((err) => `${formatPayloadInstancePath(err.instancePath)} ${err.message}`)
    .join("; ");
}

export function payloadInstanceMismatch(
  instance: unknown,
  payloadSchema: unknown,
  options?: CompilePayloadSchemaOptions,
): string | undefined {
  const schema = compilePayloadSchema(payloadSchema, options);
  if (Value.Check(schema, instance)) return undefined;
  return payloadSchemaMismatchDetails(schema, instance);
}

export function assertEnvelopePayload(
  envelope: StageEnvelope,
  payloadSchema: unknown | undefined,
  options?: CompilePayloadSchemaOptions,
): void {
  if (payloadSchema === undefined) {
    return;
  }
  if (envelope.status !== "success") {
    return;
  }

  const schema = compilePayloadSchema(payloadSchema, options);
  if (envelope.payload === undefined) {
    throw new EnvelopeError("payload is required by stage payload_schema");
  }
  if (!Value.Check(schema, envelope.payload)) {
    const details = payloadSchemaMismatchDetails(schema, envelope.payload);
    throw new EnvelopeError(
      details
        ? `payload does not match payload_schema: ${details}`
        : "payload does not match payload_schema",
    );
  }
}

/**
 * Validate clone/fan-out assignment against the successor's IR
 * `clone_input_schema` (YAML: `io.input.schema`).
 */
export function assertCloneAssignmentPayload(
  envelope: StageEnvelope,
  cloneInputSchema: unknown,
  successorId: string,
  itemPath: string = "",
  options?: CompilePayloadSchemaOptions,
): void {
  if (envelope.status !== "success") {
    return;
  }
  const schema = compilePayloadSchema(cloneInputSchema, options);
  const pathLead = itemPath ? `${itemPath}: ` : "";
  if (envelope.payload === undefined) {
    throw new EnvelopeError(
      `${pathLead}clone assignment payload is required by io.input.schema for ${successorId}`,
    );
  }
  if (!Value.Check(schema, envelope.payload)) {
    const details = payloadSchemaMismatchDetails(schema, envelope.payload);
    throw new EnvelopeError(
      details
        ? `${pathLead}clone assignment payload does not match io.input.schema for ${successorId}: ${details}`
        : `${pathLead}clone assignment payload does not match io.input.schema for ${successorId}`,
    );
  }
}
