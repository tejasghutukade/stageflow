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
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";

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
].join("\n");

describe("legacy clonable/clone_cap fields are hard-rejected: raw-ref path (resolvePipelineDag)", () => {
  it('rejects "clonable" with a message naming the field and pointing at Clone Chain', () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "triage", entry: true, route: [{ to: "implement" }] },
          { id: "implement", clonable: true, route: [{ to: "join-doc" }] },
          { id: "join-doc" },
        ],
        ctx("legacy-clonable"),
      ),
    ).toThrow(
      /stage "implement": "clonable" is no longer supported — use a Clone Chain instead/,
    );
  });

  it('rejects child "clone_cap" without clonable with a message naming the field and pointing at Clone Chain', () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "triage", entry: true, route: [{ to: "implement" }] },
          { id: "implement", clone_cap: 4, route: [{ to: "join-doc" }] },
          { id: "join-doc" },
        ],
        ctx("legacy-clone-cap"),
      ),
    ).toThrow(
      /stage "implement": "clone_cap" is no longer supported — use a Clone Chain instead/,
    );
  });

  it('rejects child "clone_cap" with clonable (clonable is named first)', () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "triage", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            clonable: true,
            clone_cap: 4,
            route: [{ to: "join-doc" }],
          },
          { id: "join-doc" },
        ],
        ctx("legacy-clone-cap-with-clonable"),
      ),
    ).toThrow(
      /stage "implement": "clonable" is no longer supported — use a Clone Chain instead/,
    );
  });

  it('rejects "clone_actions" with a message naming the field and pointing at Clone Chain', () => {
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
    ).toThrow(
      /stage "work": "clone_actions" is no longer supported — use a Clone Chain instead/,
    );
  });
});

describe("legacy clonable/clone_cap/clone_actions fields are hard-rejected: YAML path (loadPipeline)", () => {
  it('rejects "clonable" in YAML with a message naming the field and pointing at Clone Chain', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: triage",
        STAGE_BODY,
        "    entry: true",
        "    route:",
        "      - to: implement",
        "  - id: implement",
        STAGE_BODY,
        "    clonable: true",
        "    route:",
        "      - to: join-doc",
        "  - id: join-doc",
        STAGE_BODY,
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "implement": "clonable" is no longer supported — use a Clone Chain instead/,
    );
  });

  it('rejects child "clone_cap" in YAML with a message naming the field and pointing at Clone Chain', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: triage",
        STAGE_BODY,
        "    entry: true",
        "    route:",
        "      - to: implement",
        "  - id: implement",
        STAGE_BODY,
        "    clone_cap: 4",
        "    route:",
        "      - to: join-doc",
        "  - id: join-doc",
        STAGE_BODY,
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "implement": "clone_cap" is no longer supported — use a Clone Chain instead/,
    );
  });

  it('rejects "clone_actions" in YAML with a message naming the field and pointing at Clone Chain', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: work",
        STAGE_BODY,
        "    clone_actions:",
        "      - skip",
        "      - once",
        "      - fanout",
        "    entry: true",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "work": "clone_actions" is no longer supported — use a Clone Chain instead/,
    );
  });
});

describe("legacy clone_actions is hard-rejected: stage file (loadStage)", () => {
  it('rejects "clone_actions" on a stage file with a message naming the field and pointing at Clone Chain', async () => {
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
