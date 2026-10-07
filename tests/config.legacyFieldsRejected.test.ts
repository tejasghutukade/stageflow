/**
 * Ticket 07 (route-based-pipeline-wiring): `needs`, `fork`, and
 * `feedback_loop` are no longer valid pipeline-stage input fields. Every
 * stage declaring one of them must fail to load with a clear, specific
 * error naming the offending field and pointing at `route` (or
 * `route` (listed targets always run), or a `type: loop` route entry) as the
 * replacement.
 *
 * Covers both parsing seams that accept raw pipeline stage input:
 *  - `resolvePipelineDag`/`resolvePipelineDagFromRefs` (the raw-ref path,
 *    also used directly by tests and by src/config/createPipeline.ts).
 *  - `loadPipeline`/`loadPipelineOutcome` (the YAML-loading path, via
 *    `normalizePipelineStageEntries` in normalizePipelineStageEntry.ts).
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ctx = (pipelineId: string) => ({
  pipelineId,
  path: path.join(fixtures, "pipelines/test.pipeline.yaml"),
});

async function writeTempCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-legacy-rejected-"));
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

const cases = [
  {
    field: "needs",
    raw: [
      { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
      { id: "design-doc", needs: "clarify" },
    ],
    yaml: [
      { id: "clarify", extra: ["    entry: true", "    route:", "      - to: design-doc"] },
      { id: "design-doc", extra: ["    needs: clarify"] },
    ],
    message:
      /stage "design-doc": "needs" is no longer supported — declare the wiring on the source stage's "route" instead/,
  },
  {
    field: "fork",
    raw: [
      { id: "decide", entry: true, fork: { select: "one" } },
      { id: "branch-a" },
    ],
    yaml: [
      { id: "decide", extra: ["    entry: true", "    fork:", "      select: one"] },
      { id: "branch-a", extra: [] },
    ],
    message:
      /stage "decide": "fork" is no longer supported — use "route" instead; listed route targets always run/,
  },
  {
    field: "feedback_loop",
    raw: [
      { id: "plan", entry: true, route: [{ to: "review" }] },
      {
        id: "review",
        feedback_loop: {
          target: "plan",
          max_replays: 2,
          on_max_replays: "require_continue",
          replay_session: "resume",
        },
      },
    ],
    yaml: [
      { id: "plan", extra: ["    entry: true", "    route:", "      - to: review"] },
      {
        id: "review",
        extra: [
          "    feedback_loop:",
          "      target: plan",
          "      max_replays: 2",
          "      on_max_replays: require_continue",
          "      replay_session: resume",
        ],
      },
    ],
    message:
      /stage "review": "feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead/,
  },
];

describe.each(cases)("legacy $field is hard-rejected", ({ field, raw, yaml, message }) => {
  it("raw-ref path (resolvePipelineDag) names the field and its replacement", () => {
    expect(() => resolvePipelineDag(raw, ctx(`legacy-${field}`))).toThrow(message);
  });

  it("YAML path (loadPipeline) names the field and its replacement", async () => {
    const root = await writeTempCatalog({ "demo.pipeline.yaml": yamlPipeline(yaml) });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(message);
  });
});
