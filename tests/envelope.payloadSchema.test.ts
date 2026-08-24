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
  assertEnvelopePayload,
  compilePayloadSchema,
} from "../src/envelope/payloadSchema.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { EnvelopeError } from "../src/types/envelope.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  it("loads naming-ceremony stages with payload_schema", async () => {
    const suggestion = await loadStage(
      path.join(root, "stages", "name-suggestion.yaml"),
    );
    expect(suggestion.payload_schema).toMatchObject({
      type: "object",
      required: ["boy_names", "girl_names"],
    });

    const selection = await loadStage(
      path.join(root, "stages", "name-selection.yaml"),
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
});
