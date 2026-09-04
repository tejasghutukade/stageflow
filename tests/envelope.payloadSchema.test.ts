import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  compilePayloadSchema,
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
    await expect(loadStage(badType)).rejects.toThrow(/payload_schema must be an object/);

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
    await expect(loadStage(badSchema)).rejects.toThrow(/invalid payload_schema/);
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
    ).toThrow(/clone_forks\[0\]\.envelope/);
  });
});
