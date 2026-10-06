import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { pipelinePath, REPO_ROOT } from "./helpers/fixturePaths.js";

const fixtures = {
  emitterSecondRoute: "clone-chain-illegal-emitter-second-route",
  childSecondRoute: "clone-chain-illegal-child-second-route",
  ifEmitterEdge: "clone-chain-illegal-if-emitter-edge",
  ifChildEdge: "clone-chain-illegal-if-child-edge",
  childSecondParent: "clone-chain-illegal-child-second-parent",
  joinExtraParent: "clone-chain-illegal-join-extra-parent",
  twoCloneChildren: "clone-chain-illegal-two-clone-children",
  nested: "clone-chain-illegal-nested",
  inlineItems: "clone-chain-illegal-inline-items",
  twoRefArrays: "clone-chain-illegal-two-ref-arrays",
  rootArray: "clone-chain-illegal-root-array",
  childInputNotRef: "clone-chain-illegal-child-input-not-ref",
  modeOnJoin: "clone-chain-illegal-mode-on-join",
  sharedJoin: "clone-chain-illegal-shared-join",
  capOnChild: "clone-chain-illegal-cap-on-child",
} as const;

async function loadIllegal(name: string) {
  const outcome = await loadPipelineOutcome(pipelinePath(name));
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return { message: "", code: "" };
  return {
    message: outcome.issues.map((issue) => issue.message).join("\n"),
    code: outcome.issues[0]?.code,
  };
}

describe("illegal Clone Chains fail at catalog load", () => {
  it("uses one catalog kind (pipeline.dag_error) for sealed-shape errors", async () => {
    const outcome = await loadPipelineOutcome(
      pipelinePath(fixtures.emitterSecondRoute),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.every((issue) => issue.code === "pipeline.dag_error")).toBe(
      true,
    );
  });

  it("fails when the emitter has a second forward route", async () => {
    const { message } = await loadIllegal(fixtures.emitterSecondRoute);
    expect(message).toMatch(/emitter/);
    expect(message).toMatch(/forward Route|clone child/);
  });

  it("fails when the clone child has a second forward route", async () => {
    const { message } = await loadIllegal(fixtures.childSecondRoute);
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/Join/);
  });

  it("fails when if is on the emitter inbound edge", async () => {
    const { message } = await loadIllegal(fixtures.ifEmitterEdge);
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/\bif\b/);
  });

  it("fails when if is on the clone child inbound edge to the Join", async () => {
    const { message } = await loadIllegal(fixtures.ifChildEdge);
    expect(message).toMatch(/Join/);
    expect(message).toMatch(/\bif\b/);
  });

  it("fails when the clone child has a second parent", async () => {
    const { message } = await loadIllegal(fixtures.childSecondParent);
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/parent|emitter/);
  });

  it("fails when the Join has an extra parent", async () => {
    const { message } = await loadIllegal(fixtures.joinExtraParent);
    expect(message).toMatch(/Join/);
    expect(message).toMatch(/parent|clone child/);
  });

  it("fails when one emitter has two clone children", async () => {
    const { message } = await loadIllegal(fixtures.twoCloneChildren);
    expect(message).toMatch(/emitter/);
    expect(message).toMatch(/clone child/);
  });

  it("fails when the clone child output is itself a Clone Array", async () => {
    const { message } = await loadIllegal(fixtures.nested);
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/Clone Array/);
  });

  it("fails when Clone Array items are inline instead of a named $ref", async () => {
    const { message } = await loadIllegal(fixtures.inlineItems);
    expect(message).toMatch(/\$ref/);
  });

  it("fails when the emitter output has two named-$ref array fields", async () => {
    const { message } = await loadIllegal(fixtures.twoRefArrays);
    expect(message).toMatch(/\$ref/);
    expect(message).toMatch(/emitter|Clone Array/);
  });

  it("fails when the emitter output is a root-level array", async () => {
    const { message } = await loadIllegal(fixtures.rootArray);
    expect(message).toMatch(/root-level array/);
    expect(message).toMatch(/Clone Array/);
  });

  it("fails a sealed root-level-array lookalike even without clone_cap or clone_mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-illegal-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "demo.pipeline.yaml"),
      [
        "id: demo",
        "schemas:",
        "  Issue:",
        "    type: object",
        "    required: [id]",
        "    properties:",
        "      id:",
        "        type: string",
        "stages:",
        "  - id: emit-items",
        "    entry: true",
        "    route:",
        "      - to: handle-item",
        "    system_prompt: Emit items.",
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
        "  - id: handle-item",
        "    route:",
        "      - to: gather",
        "    system_prompt: Handle one.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: \"#/schemas/Issue\"",
        "      output:",
        "        schema:",
        "          type: object",
        "  - id: gather",
        "    system_prompt: Gather.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.dag_error");
    expect(outcome.issues[0]?.message).toMatch(/root-level array/);
    expect(outcome.issues[0]?.message).toMatch(/Clone Array/);
  });

  it("fails when the clone child input is not exactly the named $ref", async () => {
    const { message } = await loadIllegal(fixtures.childInputNotRef);
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/\$ref/);
  });

  it("fails a sealed lookalike whose child input is not the named $ref even without clone_cap or clone_mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-illegal-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "demo.pipeline.yaml"),
      [
        "id: demo",
        "schemas:",
        "  Issue:",
        "    type: object",
        "    required: [id]",
        "    properties:",
        "      id:",
        "        type: string",
        "stages:",
        "  - id: emit-items",
        "    entry: true",
        "    route:",
        "      - to: handle-item",
        "    system_prompt: Emit items.",
        "    model: test/model",
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
        "  - id: handle-item",
        "    route:",
        "      - to: gather",
        "    system_prompt: Handle one.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "          required: [items]",
        "          properties:",
        "            items:",
        "              type: array",
        "              items:",
        "                $ref: \"#/schemas/Issue\"",
        "      output:",
        "        schema:",
        "          type: object",
        "  - id: gather",
        "    system_prompt: Gather.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.dag_error");
    expect(outcome.issues[0]?.message).toMatch(/clone child/);
    expect(outcome.issues[0]?.message).toMatch(/\$ref/);
  });

  it("keeps 19-reject-array-item-io as pipeline.io_incompatible, not a Clone Chain dag_error", async () => {
    const outcome = await loadPipelineOutcome(
      "examples/route-wiring-smoke-test/rejected/19-reject-array-item-io.pipeline.yaml",
      { cwd: REPO_ROOT },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.io_incompatible")).toBe(
      true,
    );
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(
      false,
    );
  });

  it("fails when clone_mode is on a non-emitter (the Join)", async () => {
    const { message } = await loadIllegal(fixtures.modeOnJoin);
    expect(message).toMatch(/clone_mode/);
    expect(message).toMatch(/emitter/);
  });

  it("fails when clone_cap is on a non-emitter (the clone child)", async () => {
    const { message } = await loadIllegal(fixtures.capOnChild);
    expect(message).toMatch(/clone_cap/);
  });

  it("fails when two Clone Chains share a Join", async () => {
    const { message } = await loadIllegal(fixtures.sharedJoin);
    expect(message).toMatch(/Join/);
  });

  it("fails when the clone child has no Join (missing forward Route)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-illegal-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "demo.pipeline.yaml"),
      [
        "id: demo",
        "schemas:",
        "  Issue:",
        "    type: object",
        "    required: [id]",
        "    properties:",
        "      id:",
        "        type: string",
        "stages:",
        "  - id: emit-items",
        "    entry: true",
        "    clone_cap: 4",
        "    clone_mode: parallel",
        "    route:",
        "      - to: handle-item",
        "    system_prompt: Emit items.",
        "    model: test/model",
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
        "  - id: handle-item",
        "    system_prompt: Handle one.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: \"#/schemas/Issue\"",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.dag_error");
    expect(outcome.issues[0]?.message).toMatch(/clone child/);
    expect(outcome.issues[0]?.message).toMatch(/Join/);
  });
});
