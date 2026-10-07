/**
 * Ticket 01 (clone-chain): `clonable`, child `clone_cap`, and `clone_actions`
 * are no longer valid catalog fields. Presence must fail load with a clear
 * error naming the field and pointing at Clone Chain.
 *
 * Covers both parsing seams that accept raw pipeline stage input:
 *  - `resolvePipelineDag` (the raw-ref path)
 *  - `loadPipeline`/`loadPipelineOutcome` (the YAML-loading path)
 * Stage-file `clone_actions` is rejected via `loadStageOutcome`.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCloneChains } from "../src/config/cloneChain.js";
import {
  resolvePipelineDag,
  resolvePipelineDagFromRefs,
} from "../src/config/resolvePipelineDag.js";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import type { PipelineStageRef } from "../src/types/pipeline.js";
import type { StageConfig } from "../src/types/stage.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ctx = (pipelineId: string) => ({
  pipelineId,
  path: path.join(fixtures, "pipelines/test.pipeline.yaml"),
});

async function writeTempCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-legacy-clone-rejected-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

const STAGE_BODY = [
  "    system_prompt: Work",
  "    model: anthropic/claude-sonnet-4-5",
  "    io:",
  "      input:",
  "        schema:",
  "          type: object",
  "      output:",
  "        schema:",
  "          type: object",
];

function yamlPipeline(stages: Array<{ id: string; extra: string[] }>): string {
  return [
    "id: demo",
    "stages:",
    ...stages.flatMap((s) => [`  - id: ${s.id}`, ...STAGE_BODY, ...s.extra]),
    "",
  ].join("\n");
}

const CHAIN_YAML = (field: string[]) => [
  { id: "triage", extra: ["    entry: true", "    route:", "      - to: implement"] },
  { id: "implement", extra: [...field, "    route:", "      - to: join-doc"] },
  { id: "join-doc", extra: [] },
];

const CHAIN_RAW = (extra: Record<string, unknown>): PipelineStageRef[] => [
  { id: "triage", entry: true, route: [{ to: "implement" }] },
  { id: "implement", ...extra, route: [{ to: "join-doc" }] },
  { id: "join-doc" },
];

const MSG = (stage: string, field: string) =>
  new RegExp(
    `stage "${stage}": "${field}" is no longer supported — use a Clone Chain instead`,
  );

describe("legacy clonable is hard-rejected", () => {
  it("raw-ref path names the field and points at Clone Chain", () => {
    expect(() =>
      resolvePipelineDag(CHAIN_RAW({ clonable: true }), ctx("legacy-clonable")),
    ).toThrow(MSG("implement", "clonable"));
  });

  it("raw-ref path names clonable first when clone_cap is also present", () => {
    expect(() =>
      resolvePipelineDag(
        CHAIN_RAW({ clonable: true, clone_cap: 4 }),
        ctx("legacy-clone-cap-with-clonable"),
      ),
    ).toThrow(MSG("implement", "clonable"));
  });

  it("YAML path names the field and points at Clone Chain", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": yamlPipeline(CHAIN_YAML(["    clonable: true"])),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(MSG("implement", "clonable"));
  });
});

describe("legacy child clone_cap is hard-rejected", () => {
  it("raw-ref path rejects at apply", () => {
    const refs = CHAIN_RAW({ clone_cap: 4 });
    const { dag } = resolvePipelineDagFromRefs(refs, ctx("legacy-clone-cap"));
    const stages: StageConfig[] = refs.map((ref) => ({
      id: ref.id,
      system_prompt: "Work",
    }));
    const outcome = applyCloneChains(stages, refs, dag, "legacy-clone-cap");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(MSG("implement", "clone_cap"));
  });

  it("YAML path names the field and points at Clone Chain", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": yamlPipeline(CHAIN_YAML(["    clone_cap: 4"])),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(MSG("implement", "clone_cap"));
  });
});

describe("legacy clone_actions is hard-rejected", () => {
  it("raw-ref path names the field and points at Clone Chain", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "work",
            entry: true,
            clone_actions: ["skip", "once", "fanout"],
            system_prompt: "Work",
            io: {
              input: { schema: { type: "object" } },
              output: { schema: { type: "object" } },
            },
          },
        ],
        ctx("legacy-clone-actions"),
      ),
    ).toThrow(MSG("work", "clone_actions"));
  });

  it("YAML path names the field and points at Clone Chain", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": yamlPipeline([
        {
          id: "work",
          extra: ["    clone_actions:", "      - skip", "      - once", "      - fanout", "    entry: true"],
        },
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(MSG("work", "clone_actions"));
  });

  it("stage-file path names the field and points at Clone Chain", async () => {
    const root = await writeTempCatalog({
      "work.yaml": [
        "id: work",
        "system_prompt: Work",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      type: object",
        "clone_actions:",
        "  - skip",
        "  - once",
        "",
      ].join("\n"),
    });
    const outcome = await loadStageOutcome(path.join(root, "work.yaml"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /"clone_actions" is no longer supported — use a Clone Chain instead/,
    );
  });
});
