import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const STAGE_BODY = [
  "    system_prompt: Work",
  "    model: test/model",
  "    io:",
  "      input:",
  "        schema:",
  "          type: object",
  "      output:",
  "        schema:",
  "          type: object",
].join("\n");

const ISSUE_SCHEMA = [
  "schemas:",
  "  Issue:",
  "    type: object",
  "    required: [id, title]",
  "    properties:",
  "      id:",
  "        type: string",
  "      title:",
  "        type: string",
].join("\n");

const EMITTER_IO = [
  "    io:",
  "      input:",
  "        schema:",
  "          type: object",
  "      output:",
  "        schema:",
  "          type: object",
  "          required: [items]",
  "          properties:",
  "            items:",
  "              type: array",
  "              items:",
  "                $ref: \"#/schemas/Issue\"",
  "            summary:",
  "              type: string",
].join("\n");

const HANDLE_IO = [
  "    io:",
  "      input:",
  "        schema:",
  "          $ref: \"#/schemas/Issue\"",
  "      output:",
  "        schema:",
  "          type: object",
].join("\n");

async function writeTempCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-load-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

describe("Clone Chain catalog load", () => {
  it("loads a legal three-stage Clone Chain with named $ref, clone_cap, and clone_mode on the emitter entry", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    expect(loaded.pipeline.stages).toEqual(["emit-items", "handle-item", "gather"]);
    expect(loaded.dag.roots).toEqual(["emit-items"]);
    expect(loaded.dag.childrenOf["emit-items"]).toEqual(["handle-item"]);
    expect(loaded.dag.childrenOf["handle-item"]).toEqual(["gather"]);

    const emitter = loaded.dag.nodes.find((node) => node.id === "emit-items");
    expect(emitter).toMatchObject({
      clone_cap: 4,
      clone_mode: "parallel",
      clone_array_field: "items",
      entry: true,
    });
    const child = loaded.dag.nodes.find((node) => node.id === "handle-item");
    expect(child?.clone_cap).toBeUndefined();
    expect(child?.clone_mode).toBeUndefined();
    const join = loaded.dag.nodes.find((node) => node.id === "gather");
    expect(join?.clone_cap).toBeUndefined();
    expect(join?.clone_mode).toBeUndefined();

    const emitterStage = loaded.stages.find((stage) => stage.id === "emit-items");
    const items = (emitterStage?.payload_schema as { properties?: Record<string, unknown> })
      ?.properties?.items as { minItems?: number; maxItems?: number };
    expect(items).toMatchObject({ type: "array", minItems: 1, maxItems: 4 });
  });

  it("loads two disjoint legal Clone Chains in one pipeline", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-two-disjoint"), {
      cwd: fixtures,
    });
    expect(loaded.pipeline.stages).toEqual([
      "emit-items",
      "handle-item",
      "gather",
      "emit-notes",
      "handle-note",
      "gather-notes",
    ]);
    const emitItems = loaded.dag.nodes.find((node) => node.id === "emit-items");
    expect(emitItems).toMatchObject({
      clone_cap: 3,
      clone_mode: "parallel",
      clone_array_field: "items",
    });
    const emitNotes = loaded.dag.nodes.find((node) => node.id === "emit-notes");
    expect(emitNotes).toMatchObject({
      clone_cap: 2,
      clone_mode: "sequential",
      clone_array_field: "notes",
    });
    const handleItem = loaded.dag.nodes.find((node) => node.id === "handle-item");
    const gather = loaded.dag.nodes.find((node) => node.id === "gather");
    expect(handleItem?.clone_cap).toBeUndefined();
    expect(gather?.clone_mode).toBeUndefined();
  });

  it("accepts clone_mode sequential on the emitter entry", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        ISSUE_SCHEMA,
        "stages:",
        "  - id: emit-items",
        "    entry: true",
        "    clone_cap: 2",
        "    clone_mode: sequential",
        "    route:",
        "      - to: handle-item",
        "    system_prompt: Emit items.",
        "    model: test/model",
        EMITTER_IO,
        "  - id: handle-item",
        "    route:",
        "      - to: gather",
        "    system_prompt: Handle one.",
        "    model: test/model",
        HANDLE_IO,
        "  - id: gather",
        STAGE_BODY,
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const emitter = outcome.value.dag.nodes.find((node) => node.id === "emit-items");
    expect(emitter?.clone_mode).toBe("sequential");
    expect(emitter?.clone_cap).toBe(2);
  });

  it("rejects clone_cap and clone_mode as stage-file wiring keys", async () => {
    const root = await writeTempCatalog({
      "emit-items.yaml": [
        "id: emit-items",
        "system_prompt: Emit items.",
        "model: test/model",
        "clone_cap: 4",
        "clone_mode: parallel",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: emit-items",
        "    uses: ./emit-items.yaml",
        "    entry: true",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.message).join("\n")).toMatch(
      /wiring key "clone_cap"|unknown key "clone_cap"|clone_cap/,
    );
  });

  it("fails load when a detected Clone Chain emitter omits clone_cap or clone_mode", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        ISSUE_SCHEMA,
        "stages:",
        "  - id: emit-items",
        "    entry: true",
        "    route:",
        "      - to: handle-item",
        "    system_prompt: Emit items.",
        "    model: test/model",
        EMITTER_IO,
        "  - id: handle-item",
        "    route:",
        "      - to: gather",
        "    system_prompt: Handle one.",
        "    model: test/model",
        HANDLE_IO,
        "  - id: gather",
        STAGE_BODY,
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "emit-items".*Clone Chain emitter requires clone_cap and clone_mode/,
    );
  });

  it("does not reject a three-stage root-level JSON array handoff as a Clone Chain", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        ISSUE_SCHEMA,
        "stages:",
        "  - id: emit-list",
        "    entry: true",
        "    route:",
        "      - to: process-list",
        "    system_prompt: Emit a list.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: array",
        "          items:",
        "            $ref: \"#/schemas/Issue\"",
        "  - id: process-list",
        "    route:",
        "      - to: done",
        "    system_prompt: Process the list.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: array",
        "          items:",
        "            $ref: \"#/schemas/Issue\"",
        "      output:",
        "        schema:",
        "          type: object",
        "  - id: done",
        STAGE_BODY,
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(
      false,
    );
    expect(outcome.issues.map((issue) => issue.message).join("\n")).not.toMatch(
      /Clone Chain/,
    );
    expect(outcome.issues[0]?.code).toBe("stage.invalid_payload_schema");
  });
});
