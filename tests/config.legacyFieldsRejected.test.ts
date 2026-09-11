/**
 * Ticket 07 (route-based-pipeline-wiring): `needs`, `fork`, and
 * `feedback_loop` are no longer valid pipeline-stage input fields. Every
 * stage declaring one of them must fail to load with a clear, specific
 * error naming the offending field and pointing at `route` (or
 * `route_select`/`allow_none`, or a `type: loop` route entry) as the
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

describe("legacy needs/fork/feedback_loop fields are hard-rejected: raw-ref path (resolvePipelineDag)", () => {
  it('rejects "needs" with a message naming the field and pointing at route', () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
          { id: "design-doc", needs: "clarify" },
        ],
        ctx("legacy-needs"),
      ),
    ).toThrow(
      /stage "design-doc": "needs" is no longer supported — declare the wiring on the source stage's "route" instead/,
    );
  });

  it('rejects "fork" with a message naming the field and pointing at route_select/allow_none', () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "decide", entry: true, fork: { select: "one" } },
          { id: "branch-a" },
        ],
        ctx("legacy-fork"),
      ),
    ).toThrow(
      /stage "decide": "fork" is no longer supported — use "route_select"\/"allow_none" alongside "route" instead/,
    );
  });

  it('rejects "feedback_loop" with a message naming the field and pointing at a type: loop route entry', () => {
    expect(() =>
      resolvePipelineDag(
        [
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
        ctx("legacy-feedback-loop"),
      ),
    ).toThrow(
      /stage "review": "feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead/,
    );
  });
});

describe("legacy needs/fork/feedback_loop fields are hard-rejected: YAML path (loadPipeline)", () => {
  it('rejects "needs" in YAML with a message naming the field and pointing at route', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: clarify",
        "    system_prompt: Clarify",
        "    model: anthropic/claude-sonnet-4-5",
        "    entry: true",
        "    route:",
        "      - to: design-doc",
        "  - id: design-doc",
        "    system_prompt: Design",
        "    model: anthropic/claude-sonnet-4-5",
        "    needs: clarify",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "design-doc": "needs" is no longer supported — declare the wiring on the source stage's "route" instead/,
    );
  });

  it('rejects "fork" in YAML with a message naming the field and pointing at route_select/allow_none', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: decide",
        "    system_prompt: Decide",
        "    model: anthropic/claude-sonnet-4-5",
        "    entry: true",
        "    fork:",
        "      select: one",
        "  - id: branch-a",
        "    system_prompt: Branch",
        "    model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "decide": "fork" is no longer supported — use "route_select"\/"allow_none" alongside "route" instead/,
    );
  });

  it('rejects "feedback_loop" in YAML with a message naming the field and pointing at a type: loop route entry', async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Plan",
        "    model: anthropic/claude-sonnet-4-5",
        "    entry: true",
        "    route:",
        "      - to: review",
        "  - id: review",
        "    system_prompt: Review",
        "    model: anthropic/claude-sonnet-4-5",
        "    feedback_loop:",
        "      target: plan",
        "      max_replays: 2",
        "      on_max_replays: require_continue",
        "      replay_session: resume",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "review": "feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead/,
    );
  });
});
