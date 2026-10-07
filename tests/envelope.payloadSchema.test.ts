import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { loadStage } from "../src/config/loadStage.js";
import { assertRequiredEnvelope } from "../src/envelope/check.js";
import {
  assertCloneAssignmentPayload,
  assertEnvelopePayload,
  assertPriorInputPayload,
  compilePayloadSchema,
  isPayloadSchemaSubset,
} from "../src/envelope/payloadSchema.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { EnvelopeError } from "../src/types/envelope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests", "fixtures");

const nameListSchema = {
  type: "object",
  required: ["boy_names", "girl_names"],
  properties: {
    boy_names: { type: "array", items: { type: "string" } },
    girl_names: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const successEnvelope = (payload?: Record<string, unknown>) =>
  assertRequiredEnvelope({
    status: "success",
    summary: "ok",
    artifacts: [],
    ...(payload === undefined ? {} : { payload }),
  });

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...extra,
});

const field = (name: string, node: Record<string, unknown>) => obj({ [name]: node });

describe("payload_schema", () => {
  it("compiles a JSON Schema subset and rejects unsupported constructs", () => {
    expect(() => compilePayloadSchema(nameListSchema)).not.toThrow();
    expect(() =>
      compilePayloadSchema({ type: "object", properties: { x: { type: "null" } } }),
    ).toThrow(/unsupported type/);
    expect(() => compilePayloadSchema({ type: "string" })).toThrow(
      /root type must be object/,
    );
  });

  it("requires matching payload on success and skips on failure", () => {
    const success = successEnvelope({ boy_names: ["Arjun"], girl_names: ["Meera"] });
    expect(() => assertEnvelopePayload(success, nameListSchema)).not.toThrow();

    expect(() => assertEnvelopePayload(successEnvelope(), nameListSchema)).toThrow(
      EnvelopeError,
    );

    const wrong = successEnvelope({ boy_names: "Arjun" });
    expect(() => assertEnvelopePayload(wrong, nameListSchema)).toThrow(EnvelopeError);

    const failure = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(() => assertEnvelopePayload(failure, nameListSchema)).not.toThrow();

    const strictSchema = {
      type: "object",
      required: ["result", "changed_files"],
      properties: {
        result: { type: "string", enum: ["pass"] },
        changed_files: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    };
    const failureWithBadPayload = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
      payload: { result: "fail", changed_files: [] },
    });
    expect(() => assertEnvelopePayload(failureWithBadPayload, strictSchema)).not.toThrow();
    expect(() =>
      assertEnvelopePayload(successEnvelope({ result: "fail", changed_files: [] }), strictSchema),
    ).toThrow(EnvelopeError);
  });

  it("KTD2: mismatch messages use payload.field dialect not slash instancePath", () => {
    const success = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { boy_names: "Arjun", girl_names: ["Meera"] },
    });
    let topMessage = "";
    try {
      assertEnvelopePayload(success, nameListSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      topMessage = err instanceof Error ? err.message : String(err);
    }
    expect(topMessage).toMatch(/payload\.boy_names/);
    expect(topMessage).not.toMatch(/\/boy_names/);

    const cloneEnv = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { branch: 12 },
    });
    let cloneMessage = "";
    try {
      assertCloneAssignmentPayload(
        cloneEnv,
        {
          type: "object",
          properties: { branch: { type: "string" } },
          required: ["branch"],
        },
        "investigate",
        "assignment",
      );
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      cloneMessage = err instanceof Error ? err.message : String(err);
    }
    expect(cloneMessage).toMatch(/payload\.branch/);
    expect(cloneMessage).not.toMatch(/\/branch/);
  });

  it("AE2: retained dual-read pair loads to equal IR", async () => {
    const legacyPath = path.join(fixtures, "stages", "name-suggestion.yaml");
    const targetPath = path.join(
      fixtures,
      "dual-read",
      "target",
      "name-suggestion.yaml",
    );
    const legacyYaml = await readFile(legacyPath, "utf8");
    const targetYaml = await readFile(targetPath, "utf8");
    expect(legacyYaml).toMatch(/^payload_schema:/m);
    expect(legacyYaml).not.toMatch(/^io:/m);
    expect(targetYaml).toMatch(/^io:/m);
    expect(targetYaml).not.toMatch(/^payload_schema:/m);

    const legacy = await loadStage(legacyPath);
    const target = await loadStage(targetPath);
    expect({
      payload_schema: target.payload_schema,
      clone_input_schema: target.clone_input_schema,
      pre_emit_checks: target.pre_emit_checks,
      gate_kinds: target.gate_kinds,
      timeout_ms: target.timeout_ms,
      skill: target.skill,
      mcp: target.mcp,
      system_prompt: target.system_prompt,
      model: target.model,
    }).toEqual({
      payload_schema: legacy.payload_schema,
      clone_input_schema: legacy.clone_input_schema,
      pre_emit_checks: legacy.pre_emit_checks,
      gate_kinds: legacy.gate_kinds,
      timeout_ms: legacy.timeout_ms,
      skill: legacy.skill,
      mcp: legacy.mcp,
      system_prompt: legacy.system_prompt,
      model: legacy.model,
    });
  });

  it("rejects non-object or invalid payload_schema at stage load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stage-"));
    const badType = path.join(dir, "bad-type.yaml");
    await writeFile(
      badType,
      [
        "id: bad-type",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema: not-an-object",
        "",
      ].join("\n"),
    );
    await expect(loadStage(badType)).rejects.toThrow(/io\.output\.schema must be an object/);

    const badSchema = path.join(dir, "bad-schema.yaml");
    await writeFile(
      badSchema,
      [
        "id: bad-schema",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: string",
        "",
      ].join("\n"),
    );
    await expect(loadStage(badSchema)).rejects.toThrow(/invalid io\.output\.schema/);
  });

  it("FakeAgent enforces stage payload_schema", async () => {
    const input: StageRunInput = {
      roots: buildStageRoots("/tmp", "name-suggestion"),
      stage: {
        id: "name-suggestion",
        system_prompt: "suggest",
        model: "cursor/composer-2-5",
        payload_schema: nameListSchema,
      },
      task: { id: "t", goal: "names" },
      priorEnvelope: null,
    };

    const ok = await new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "ok",
        artifacts: [],
        payload: {
          boy_names: ["Arjun"],
          girl_names: ["Meera"],
        },
      },
    }).runStage(input);
    expect(ok.ok).toBe(true);

    const bad = await new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "ok",
        artifacts: [],
      },
    }).runStage(input);
    expect(bad.ok).toBe(false);
  });

  it.each([
    {
      name: "minItems 1 on a required array",
      schema: field("changed_files", { type: "array", items: { type: "string" }, minItems: 1 }),
      accept: [{ changed_files: ["src/foo.ts"] }],
      reject: [{ changed_files: [] }],
    },
    {
      name: "string enum",
      schema: field("result", { type: "string", enum: ["pass"] }),
      accept: [{ result: "pass" }],
      reject: [{ result: "fail" }],
    },
    {
      name: "integer minimum and maximum",
      schema: field("investigation_count", { type: "integer", minimum: 1, maximum: 5 }),
      accept: [{ investigation_count: 1 }, { investigation_count: 5 }],
      reject: [{ investigation_count: 0 }, { investigation_count: 6 }],
    },
    {
      name: "string pattern with minLength and maxLength",
      schema: field("code", { type: "string", pattern: "^[a-z]{2,4}$", minLength: 2, maxLength: 4 }),
      accept: [{ code: "ab" }, { code: "abcd" }],
      reject: [{ code: "a" }, { code: "abcdef" }, { code: "AB" }],
    },
    {
      name: "combined enum, pattern and minLength",
      schema: field("code", { type: "string", enum: ["a", "AB"], pattern: "^[A-Z]+$", minLength: 2 }),
      accept: [{ code: "AB" }],
      reject: [{ code: "a" }],
    },
    {
      name: "nullable nodes in addition to the base type",
      schema: obj(
        {
          note: { type: "string", nullable: true },
          detail: obj(
            { mode: { type: "string", nullable: true } },
            { required: ["mode"], additionalProperties: false },
          ),
        },
        { required: ["note", "detail"], additionalProperties: false },
      ),
      accept: [
        { note: "ok", detail: { mode: null } },
        { note: null, detail: { mode: "strict" } },
        { note: null, detail: { mode: null } },
      ],
      reject: [
        { note: 7, detail: { mode: "strict" } },
        { note: "ok", detail: { mode: 1 } },
      ],
    },
    {
      name: "nullable enum node",
      schema: field("status", { type: "string", enum: ["pass"], nullable: true }),
      accept: [{ status: "pass" }, { status: null }],
      reject: [{ status: "fail" }],
    },
  ])("enforces $name", ({ schema, accept, reject }) => {
    const required = { ...schema, required: schema.required ?? Object.keys(schema.properties) };
    for (const payload of accept) {
      expect(() => assertEnvelopePayload(successEnvelope(payload), required)).not.toThrow();
    }
    for (const payload of reject) {
      expect(() => assertEnvelopePayload(successEnvelope(payload), required)).toThrow(
        EnvelopeError,
      );
    }
  });

  it.each([
    { name: "invalid pattern regex", node: { type: "string", pattern: "[" }, err: /pattern must be a valid regular expression/ },
    { name: "backreference pattern", node: { type: "string", pattern: "\\1" }, err: /pattern must be a valid regular expression/ },
    { name: "non-string pattern", node: { type: "string", pattern: 5 }, err: /pattern must be a string when present/ },
    { name: "negative minLength", node: { type: "string", minLength: -1 }, err: /minLength must be a non-negative integer/ },
    { name: "fractional maxLength", node: { type: "string", maxLength: 1.5 }, err: /maxLength must be a non-negative integer/ },
    { name: "minLength above maxLength", node: { type: "string", minLength: 5, maxLength: 2 }, err: /minLength must be <= maxLength/ },
    { name: "non-boolean nullable", node: { type: "string", nullable: "yes" }, err: /nullable must be a boolean when present/ },
  ])("rejects $name at compile time", ({ node, err }) => {
    expect(() => compilePayloadSchema(field("code", node))).toThrow(err);
  });

  it("rejects nullable root at compile time", () => {
    expect(() => compilePayloadSchema(obj({}, { nullable: true }))).toThrow(
      /root cannot be nullable/,
    );
  });

  it("compiles unknown keywords without failing load", () => {
    const schema = {
      type: "object",
      required: ["label"],
      properties: {
        label: {
          type: "string",
          format: "email",
          title: "Label",
          "x-decorative": true,
        },
      },
    };
    expect(() => compilePayloadSchema(schema)).not.toThrow();
    const ok = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { label: "not-an-email" },
    });
    expect(() => assertEnvelopePayload(ok, schema)).not.toThrow();
  });

  const storySliceSchema = {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
    },
  };

  it("does not ignore $ref: $ref-only nodes fail without a resolver", () => {
    expect(() =>
      compilePayloadSchema({ $ref: "#/schemas/story-slice" }),
    ).toThrow(/unresolved|\$ref/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: {
          label: { type: "string", $ref: "#/schemas/missing" },
        },
      }),
    ).toThrow(/unresolved|\$ref/);
  });

  it("compiles $ref-only nodes against a pipeline schemas map", () => {
    const compiled = compilePayloadSchema(
      { $ref: "#/schemas/story-slice" },
      { schemas: { "story-slice": storySliceSchema } },
    );
    expect(compiled).toBeDefined();
    const ok = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { title: "slice-1" },
    });
    expect(() =>
      assertEnvelopePayload(ok, { $ref: "#/schemas/story-slice" }, {
        schemas: { "story-slice": storySliceSchema },
      }),
    ).not.toThrow();
    const missing = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: {},
    });
    expect(() =>
      assertEnvelopePayload(missing, { $ref: "#/schemas/story-slice" }, {
        schemas: { "story-slice": storySliceSchema },
      }),
    ).toThrow(EnvelopeError);
  });

  it("rejects $ref cycles", () => {
    expect(() =>
      compilePayloadSchema(
        { $ref: "#/schemas/a" },
        {
          schemas: {
            a: { $ref: "#/schemas/b" },
            b: { $ref: "#/schemas/a" },
          },
        },
      ),
    ).toThrow(/cycle/i);
  });
  const schemas = {
    produced: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    },
    consumed: {
      type: "object",
      required: ["title", "extra"],
      properties: { title: { type: "string" }, extra: { type: "string" } },
    },
  };
  const title = { type: "string" };
  const codeOf = (node: Record<string, unknown>) => field("code", { type: "string", ...node });
  const nOf = (node: Record<string, unknown>) => field("n", node);
  const closedTitle = obj({ title }, { additionalProperties: false });
  const arrayOf = (extra: Record<string, unknown>) =>
    field("tags", { type: "array", items: { type: "string" }, ...extra });

  it.each([
    {
      name: "same $ref on both sides",
      consumer: { $ref: "#/schemas/produced" },
      producer: { $ref: "#/schemas/produced" },
      expected: true,
    },
    {
      name: "producer with extra required fields",
      consumer: schemas.produced,
      producer: obj({ title, body: title }, { required: ["title", "body"] }),
      expected: true,
    },
    {
      name: "consumer $ref requiring more than the produced $ref",
      consumer: { $ref: "#/schemas/consumed" },
      producer: { $ref: "#/schemas/produced" },
      expected: false,
    },
    {
      name: "produced $ref covering a smaller consumed $ref",
      consumer: { $ref: "#/schemas/produced" },
      producer: { $ref: "#/schemas/consumed" },
      expected: true,
    },
    {
      name: "extra producer property vs closed consumer",
      consumer: closedTitle,
      producer: obj({ title, extra: title }),
      expected: false,
    },
    {
      name: "same properties vs closed consumer",
      consumer: obj({ title, note: title }, { additionalProperties: false }),
      producer: obj({ title, note: title }, { additionalProperties: false }),
      expected: true,
    },
    {
      name: "fewer properties vs closed consumer",
      consumer: obj({ title, note: title }, { additionalProperties: false }),
      producer: obj({ title }, { additionalProperties: false }),
      expected: true,
    },
    {
      name: "implicitly open producer vs closed consumer",
      consumer: closedTitle,
      producer: obj({ title }),
      expected: false,
    },
    {
      name: "explicitly open producer vs closed consumer",
      consumer: closedTitle,
      producer: obj({ title }, { additionalProperties: true }),
      expected: false,
    },
    {
      name: "extra producer fields vs open consumer",
      consumer: obj({ title }),
      producer: obj({ title, extra: title }),
      expected: true,
    },
    {
      name: "number consumer of integer producer",
      consumer: nOf({ type: "number" }),
      producer: nOf({ type: "integer" }),
      expected: true,
    },
    {
      name: "integer consumer of number producer",
      consumer: nOf({ type: "integer" }),
      producer: nOf({ type: "number" }),
      expected: false,
    },
    { name: "equal minItems", consumer: arrayOf({ minItems: 2 }), producer: arrayOf({ minItems: 2 }), expected: true },
    { name: "producer minItems below consumer", consumer: arrayOf({ minItems: 2 }), producer: arrayOf({ minItems: 1 }), expected: false },
    { name: "producer without minItems", consumer: arrayOf({ minItems: 2 }), producer: arrayOf({}), expected: false },
    {
      name: "nullable producer vs non-nullable consumer",
      consumer: field("title", title),
      producer: field("title", { ...title, nullable: true }),
      expected: false,
    },
    {
      name: "nullable on both sides",
      consumer: field("title", { ...title, nullable: true }),
      producer: field("title", { ...title, nullable: true }),
      expected: true,
    },
    {
      name: "nullable array producer vs non-nullable consumer",
      consumer: arrayOf({}),
      producer: arrayOf({ nullable: true }),
      expected: false,
    },
    {
      name: "nullable object producer vs non-nullable consumer",
      consumer: field("meta", obj({ title })),
      producer: field("meta", { ...obj({ title }), nullable: true }),
      expected: false,
    },
    {
      name: "enum subset producer",
      consumer: field("result", { type: "string", enum: ["pass", "fail"] }),
      producer: field("result", { type: "string", enum: ["pass"] }),
      expected: true,
    },
    {
      name: "enum superset producer",
      consumer: field("result", { type: "string", enum: ["pass"] }),
      producer: field("result", { type: "string", enum: ["pass", "fail"] }),
      expected: false,
    },
    {
      name: "unconstrained consumer of enum producer",
      consumer: field("result", { type: "string" }),
      producer: field("result", { type: "string", enum: ["pass"] }),
      expected: true,
    },
    {
      name: "enum consumer of unconstrained producer",
      consumer: field("result", { type: "string", enum: ["pass"] }),
      producer: field("result", { type: "string" }),
      expected: false,
    },
    { name: "identical pattern", consumer: codeOf({ pattern: "^[a-z]{2,4}$" }), producer: codeOf({ pattern: "^[a-z]{2,4}$" }), expected: true },
    { name: "different pattern", consumer: codeOf({ pattern: "^[a-z]{2,4}$" }), producer: codeOf({ pattern: "^[a-z]+$" }), expected: false },
    { name: "patterned consumer of unpatterned producer", consumer: codeOf({ pattern: "^[a-z]{2,4}$" }), producer: codeOf({}), expected: false },
    { name: "unpatterned consumer of patterned producer", consumer: codeOf({}), producer: codeOf({ pattern: "^[a-z]{2,4}$" }), expected: true },
    {
      name: "producer integer bounds inside consumer bounds",
      consumer: nOf({ type: "integer", minimum: 1, maximum: 10 }),
      producer: nOf({ type: "integer", minimum: 2, maximum: 8 }),
      expected: true,
    },
    {
      name: "unbounded producer vs bounded consumer",
      consumer: nOf({ type: "integer", minimum: 1, maximum: 10 }),
      producer: nOf({ type: "integer" }),
      expected: false,
    },
    {
      name: "bounded producer vs unbounded consumer",
      consumer: nOf({ type: "integer" }),
      producer: nOf({ type: "integer", minimum: 1, maximum: 10 }),
      expected: true,
    },
    {
      name: "producer minimum below consumer minimum",
      consumer: nOf({ type: "number", minimum: 0, maximum: 5 }),
      producer: nOf({ type: "number", minimum: -1, maximum: 5 }),
      expected: false,
    },
    {
      name: "producer length bounds inside consumer bounds",
      consumer: codeOf({ minLength: 2, maxLength: 8 }),
      producer: codeOf({ minLength: 3, maxLength: 6 }),
      expected: true,
    },
    {
      name: "unbounded producer length vs bounded consumer",
      consumer: codeOf({ minLength: 2, maxLength: 8 }),
      producer: codeOf({}),
      expected: false,
    },
    {
      name: "bounded producer length vs unbounded consumer",
      consumer: codeOf({}),
      producer: codeOf({ minLength: 2, maxLength: 8 }),
      expected: true,
    },
  ])("isPayloadSchemaSubset: $name -> $expected", ({ consumer, producer, expected }) => {
    expect(isPayloadSchemaSubset(consumer, producer, { schemas })).toBe(expected);
  });

  it("U1: assertCloneAssignmentPayload missing payload includes itemPath", () => {
    const envelope = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(() =>
      assertCloneAssignmentPayload(
        envelope,
        nameListSchema,
        "author-diagrams",
        "assignment",
      ),
    ).toThrow(/assignment: clone assignment payload is required by io\.input\.schema/);
  });

  it("assertPriorInputPayload requires payload and names the child io.input.schema", () => {
    const missing = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(() =>
      assertPriorInputPayload(missing, nameListSchema, "design-doc"),
    ).toThrow(
      /^prior payload is required by io\.input\.schema for design-doc$/,
    );

    const wrong = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { boy_names: "Arjun" },
    });
    let message = "";
    try {
      assertPriorInputPayload(wrong, nameListSchema, "design-doc");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(
      /^prior payload does not match io\.input\.schema for design-doc:/,
    );
    expect(message).toMatch(/payload\.boy_names/);
    expect(message).not.toMatch(/\/boy_names/);

    const ok = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: {
        boy_names: ["Arjun"],
        girl_names: ["Meera"],
      },
    });
    expect(() => assertPriorInputPayload(ok, nameListSchema, "design-doc")).not.toThrow();

    const failure = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(() =>
      assertPriorInputPayload(failure, nameListSchema, "design-doc"),
    ).not.toThrow();
  });
});
