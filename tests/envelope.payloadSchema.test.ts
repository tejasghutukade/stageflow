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
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";

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
    const success = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: {
        boy_names: ["Arjun"],
        girl_names: ["Meera"],
      },
    });
    expect(() => assertEnvelopePayload(success, nameListSchema)).not.toThrow();

    const missing = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(() => assertEnvelopePayload(missing, nameListSchema)).toThrow(
      EnvelopeError,
    );

    const wrong = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { boy_names: "Arjun" },
    });
    expect(() => assertEnvelopePayload(wrong, nameListSchema)).toThrow(
      EnvelopeError,
    );

    const failure = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(() => assertEnvelopePayload(failure, nameListSchema)).not.toThrow();
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
        "clone_forks[0].envelope",
      );
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      cloneMessage = err instanceof Error ? err.message : String(err);
    }
    expect(cloneMessage).toMatch(/payload\.branch/);
    expect(cloneMessage).not.toMatch(/\/branch/);
  });

  it("loads naming-ceremony stages with payload_schema", async () => {
    const suggestion = await loadStage(
      path.join(fixtures, "stages", "name-suggestion.yaml"),
    );
    expect(suggestion.payload_schema).toMatchObject({
      type: "object",
      required: ["boy_names", "girl_names"],
    });

    const selection = await loadStage(
      path.join(fixtures, "stages", "name-selection.yaml"),
    );
    expect(selection.payload_schema).toMatchObject({
      type: "object",
      required: ["boy", "girl"],
    });
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
      clone_actions: target.clone_actions,
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
      clone_actions: legacy.clone_actions,
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

  it("emit tool accepts matching payload and rejects bad payload on success", async () => {
    const okCapture = {};
    const okTool = createEmitStageEnvelopeTool(okCapture, nameListSchema);
    const ok = await okTool.execute("1", {
      status: "success",
      summary: "names",
      artifacts: [],
      payload: {
        boy_names: ["Arjun"],
        girl_names: ["Meera"],
      },
    });
    expect(ok.isError).toBeUndefined();
    expect(okCapture).toHaveProperty("envelope");

    const badCapture = {};
    const badTool = createEmitStageEnvelopeTool(badCapture, nameListSchema);
    const bad = await badTool.execute("1", {
      status: "success",
      summary: "names",
      artifacts: [],
      payload: { names: ["Arjun"] },
    });
    expect(bad.isError).toBe(true);
    expect(badCapture).not.toHaveProperty("envelope");
  });

  it("emit tool skips payload_schema when status is failure", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture, nameListSchema);
    const out = await tool.execute("1", {
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(out.isError).toBeUndefined();
    expect(capture).toMatchObject({
      envelope: { status: "failure" },
    });
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

  it("rejects empty required arrays when minItems is 1", () => {
    const schema = {
      type: "object",
      required: ["changed_files"],
      properties: {
        changed_files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
    };
    const empty = assertRequiredEnvelope({
      status: "success",
      summary: "implemented",
      artifacts: [],
      payload: { changed_files: [] },
    });
    expect(() => assertEnvelopePayload(empty, schema)).toThrow(EnvelopeError);

    const filled = assertRequiredEnvelope({
      status: "success",
      summary: "implemented",
      artifacts: [],
      payload: { changed_files: ["src/foo.ts"] },
    });
    expect(() => assertEnvelopePayload(filled, schema)).not.toThrow();
  });

  it("rejects success emit of empty required array with minItems (AE1)", async () => {
    const schema = {
      type: "object",
      required: ["changed_files"],
      properties: {
        changed_files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
    };
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture, schema);
    const out = await tool.execute("1", {
      status: "success",
      summary: "implemented",
      artifacts: [],
      payload: { changed_files: [] },
    });
    expect(out.isError).toBe(true);
    expect(out).not.toHaveProperty("terminate");
    expect(capture).not.toHaveProperty("envelope");
  });

  it("rejects string values outside enum", () => {
    const schema = {
      type: "object",
      required: ["result"],
      properties: {
        result: { type: "string", enum: ["pass"] },
      },
    };
    const fail = assertRequiredEnvelope({
      status: "success",
      summary: "checked",
      artifacts: [],
      payload: { result: "fail" },
    });
    expect(() => assertEnvelopePayload(fail, schema)).toThrow(EnvelopeError);

    const pass = assertRequiredEnvelope({
      status: "success",
      summary: "checked",
      artifacts: [],
      payload: { result: "pass" },
    });
    expect(() => assertEnvelopePayload(pass, schema)).not.toThrow();
  });

  it("rejects integers outside minimum and maximum", () => {
    const schema = {
      type: "object",
      required: ["investigation_count"],
      properties: {
        investigation_count: { type: "integer", minimum: 1, maximum: 5 },
      },
    };
    for (const value of [0, 6]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "planned",
        artifacts: [],
        payload: { investigation_count: value },
      });
      expect(() => assertEnvelopePayload(envelope, schema)).toThrow(
        EnvelopeError,
      );
    }
    for (const value of [1, 5]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "planned",
        artifacts: [],
        payload: { investigation_count: value },
      });
      expect(() => assertEnvelopePayload(envelope, schema)).not.toThrow();
    }
  });

  it("rejects strings outside pattern/minLength/maxLength", () => {
    const schema = {
      type: "object",
      required: ["code"],
      properties: {
        code: {
          type: "string",
          pattern: "^[a-z]{2,4}$",
          minLength: 2,
          maxLength: 4,
        },
      },
    };
    for (const value of ["a", "abcdef", "AB"]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "checked",
        artifacts: [],
        payload: { code: value },
      });
      expect(() => assertEnvelopePayload(envelope, schema)).toThrow(
        EnvelopeError,
      );
    }
    for (const value of ["ab", "abcd"]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "checked",
        artifacts: [],
        payload: { code: value },
      });
      expect(() => assertEnvelopePayload(envelope, schema)).not.toThrow();
    }
  });

  it("rejects invalid pattern and negative/non-integer string bounds at compile time", () => {
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", pattern: "[" } },
      }),
    ).toThrow(/pattern must be a valid regular expression/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", pattern: "\\1" } },
      }),
    ).toThrow(/pattern must be a valid regular expression/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", pattern: 5 } },
      }),
    ).toThrow(/pattern must be a string when present/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", minLength: -1 } },
      }),
    ).toThrow(/minLength must be a non-negative integer/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", maxLength: 1.5 } },
      }),
    ).toThrow(/maxLength must be a non-negative integer/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", minLength: 5, maxLength: 2 } },
      }),
    ).toThrow(/minLength must be <= maxLength/);
    expect(() =>
      compilePayloadSchema({
        type: "object",
        properties: { code: { type: "string", nullable: "yes" } },
      }),
    ).toThrow(/nullable must be a boolean when present/);
  });

  it("rejects strings that fail combined enum and pattern/minLength constraints", () => {
    const schema = {
      type: "object",
      required: ["code"],
      properties: {
        code: {
          type: "string",
          enum: ["a", "AB"],
          pattern: "^[A-Z]+$",
          minLength: 2,
        },
      },
    };
    const reject = assertRequiredEnvelope({
      status: "success",
      summary: "checked",
      artifacts: [],
      payload: { code: "a" },
    });
    expect(() => assertEnvelopePayload(reject, schema)).toThrow(EnvelopeError);

    const accept = assertRequiredEnvelope({
      status: "success",
      summary: "checked",
      artifacts: [],
      payload: { code: "AB" },
    });
    expect(() => assertEnvelopePayload(accept, schema)).not.toThrow();
  });

  it("rejects nullable root at compile time", () => {
    expect(() =>
      compilePayloadSchema({
        type: "object",
        nullable: true,
        properties: {},
      }),
    ).toThrow(/root cannot be nullable/);
  });

  it("allows null for a nullable node in addition to its base type", () => {
    const schema = {
      type: "object",
      required: ["note", "detail"],
      properties: {
        note: { type: "string", nullable: true },
        detail: {
          type: "object",
          required: ["mode"],
          properties: { mode: { type: "string", nullable: true } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    for (const payload of [
      { note: "ok", detail: { mode: null } },
      { note: null, detail: { mode: "strict" } },
      { note: null, detail: { mode: null } },
    ]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "checked",
        artifacts: [],
        payload,
      });
      expect(() => assertEnvelopePayload(envelope, schema)).not.toThrow();
    }

    // Values of neither the base type nor null are rejected.
    for (const payload of [
      { note: 7, detail: { mode: "strict" } },
      { note: "ok", detail: { mode: 1 } },
    ]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "checked",
        artifacts: [],
        payload,
      });
      expect(() => assertEnvelopePayload(envelope, schema)).toThrow(
        EnvelopeError,
      );
    }
  });

  it("allows null for a nullable enum node", () => {
    const schema = {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["pass"], nullable: true } },
    };
    for (const value of ["pass", null]) {
      const envelope = assertRequiredEnvelope({
        status: "success",
        summary: "checked",
        artifacts: [],
        payload: { status: value },
      });
      expect(() => assertEnvelopePayload(envelope, schema)).not.toThrow();
    }
    const bad = assertRequiredEnvelope({
      status: "success",
      summary: "checked",
      artifacts: [],
      payload: { status: "fail" },
    });
    expect(() => assertEnvelopePayload(bad, schema)).toThrow(EnvelopeError);
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

  it("treats consumer input as a structural subset of producer output after resolve", () => {
    const schemas = {
      produced: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
      consumed: {
        type: "object",
        required: ["title", "extra"],
        properties: {
          title: { type: "string" },
          extra: { type: "string" },
        },
      },
    };
    expect(
      isPayloadSchemaSubset(
        { $ref: "#/schemas/produced" },
        { $ref: "#/schemas/produced" },
        { schemas },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
        {
          type: "object",
          required: ["title", "body"],
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
        },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        { $ref: "#/schemas/consumed" },
        { $ref: "#/schemas/produced" },
        { schemas },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        { $ref: "#/schemas/produced" },
        { $ref: "#/schemas/consumed" },
        { schemas },
      ),
    ).toBe(true);
  });

  it("rejects extra producer properties when consumer sets additionalProperties false", () => {
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" } },
        },
        {
          type: "object",
          properties: {
            title: { type: "string" },
            extra: { type: "string" },
          },
        },
      ),
    ).toBe(false);
  });

  it("accepts number consumer of integer producer and rejects integer consumer of number producer", () => {
    const numberField = {
      type: "object",
      properties: { n: { type: "number" } },
    };
    const integerField = {
      type: "object",
      properties: { n: { type: "integer" } },
    };
    expect(isPayloadSchemaSubset(numberField, integerField)).toBe(true);
    expect(isPayloadSchemaSubset(integerField, numberField)).toBe(false);
  });

  it("requires producer minItems to fit the consumer array bound", () => {
    const consumer = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 2 },
      },
    };
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 2 },
        },
      }),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      }),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    ).toBe(false);
  });

  it("accepts the same or fewer producer properties when consumer sets additionalProperties false", () => {
    const consumer = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        note: { type: "string" },
      },
    };
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" }, note: { type: "string" } },
      }),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" } },
      }),
    ).toBe(true);
  });

  it("rejects an open producer when the consumer sets additionalProperties false", () => {
    const consumer = {
      type: "object",
      additionalProperties: false,
      properties: { title: { type: "string" } },
    };
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        properties: { title: { type: "string" } },
      }),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(consumer, {
        type: "object",
        additionalProperties: true,
        properties: { title: { type: "string" } },
      }),
    ).toBe(false);
  });

  it("rejects a nullable producer when the consumer is not nullable", () => {
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { title: { type: "string" } },
        },
        {
          type: "object",
          properties: { title: { type: "string", nullable: true } },
        },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { title: { type: "string", nullable: true } },
        },
        {
          type: "object",
          properties: { title: { type: "string", nullable: true } },
        },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
          },
        },
        {
          type: "object",
          properties: {
            tags: { type: "array", nullable: true, items: { type: "string" } },
          },
        },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: {
            meta: { type: "object", properties: { title: { type: "string" } } },
          },
        },
        {
          type: "object",
          properties: {
            meta: {
              type: "object",
              nullable: true,
              properties: { title: { type: "string" } },
            },
          },
        },
      ),
    ).toBe(false);
  });

  it("allows extra producer fields when consumer omits additionalProperties false", () => {
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { title: { type: "string" } },
        },
        {
          type: "object",
          properties: {
            title: { type: "string" },
            extra: { type: "string" },
          },
        },
      ),
    ).toBe(true);
  });

  it("treats producer enum as compatible only when every value is accepted by the consumer", () => {
    const passFail = {
      type: "object",
      properties: { result: { type: "string", enum: ["pass", "fail"] } },
    };
    const passOnly = {
      type: "object",
      properties: { result: { type: "string", enum: ["pass"] } },
    };
    const unconstrained = {
      type: "object",
      properties: { result: { type: "string" } },
    };
    expect(isPayloadSchemaSubset(passFail, passOnly)).toBe(true);
    expect(isPayloadSchemaSubset(passOnly, passFail)).toBe(false);
    expect(isPayloadSchemaSubset(unconstrained, passOnly)).toBe(true);
    expect(isPayloadSchemaSubset(passOnly, unconstrained)).toBe(false);
  });

  it("requires identical string patterns when the consumer constrains pattern", () => {
    const codePattern = "^[a-z]{2,4}$";
    const patterned = {
      type: "object",
      properties: { code: { type: "string", pattern: codePattern } },
    };
    expect(
      isPayloadSchemaSubset(patterned, {
        type: "object",
        properties: { code: { type: "string", pattern: codePattern } },
      }),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(patterned, {
        type: "object",
        properties: { code: { type: "string", pattern: "^[a-z]+$" } },
      }),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(patterned, {
        type: "object",
        properties: { code: { type: "string" } },
      }),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { code: { type: "string" } },
        },
        patterned,
      ),
    ).toBe(true);
  });

  it("requires producer min/max and minLength/maxLength to fit inside consumer bounds", () => {
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { n: { type: "integer", minimum: 1, maximum: 10 } },
        },
        {
          type: "object",
          properties: { n: { type: "integer", minimum: 2, maximum: 8 } },
        },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { n: { type: "integer", minimum: 1, maximum: 10 } },
        },
        {
          type: "object",
          properties: { n: { type: "integer" } },
        },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { n: { type: "integer" } },
        },
        {
          type: "object",
          properties: { n: { type: "integer", minimum: 1, maximum: 10 } },
        },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { n: { type: "number", minimum: 0, maximum: 5 } },
        },
        {
          type: "object",
          properties: { n: { type: "number", minimum: -1, maximum: 5 } },
        },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { code: { type: "string", minLength: 2, maxLength: 8 } },
        },
        {
          type: "object",
          properties: { code: { type: "string", minLength: 3, maxLength: 6 } },
        },
      ),
    ).toBe(true);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { code: { type: "string", minLength: 2, maxLength: 8 } },
        },
        {
          type: "object",
          properties: { code: { type: "string" } },
        },
      ),
    ).toBe(false);
    expect(
      isPayloadSchemaSubset(
        {
          type: "object",
          properties: { code: { type: "string" } },
        },
        {
          type: "object",
          properties: { code: { type: "string", minLength: 2, maxLength: 8 } },
        },
      ),
    ).toBe(true);
  });

  it("failure envelopes skip enum and minItems checks", () => {
    const schema = {
      type: "object",
      required: ["result", "changed_files"],
      properties: {
        result: { type: "string", enum: ["pass"] },
        changed_files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
    };
    const failure = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
      payload: { result: "fail", changed_files: [] },
    });
    expect(() => assertEnvelopePayload(failure, schema)).not.toThrow();
  });

  it("stages without payload_schema still accept untyped payload", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const out = await tool.execute("1", {
      status: "success",
      summary: "ok",
      artifacts: [],
      payload: { anything: true },
    });
    expect(out.isError).toBeUndefined();
    expect(capture).toMatchObject({
      envelope: { payload: { anything: true } },
    });
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
        "clone_forks[0].envelope",
      ),
    ).toThrow(/clone_forks\[0\]\.envelope: clone assignment payload is required by io\.input\.schema/);
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
