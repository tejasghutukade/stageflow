import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];

after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8" });
  return { status: result.status, json: JSON.parse(result.stdout.trim()), stderr: result.stderr };
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("locate-session-transcript.mjs", () => {
  it("finds a Claude Code project whose cwd has spaces, dots and underscores", () => {
    const home = tempDir("sf-loc-home-");
    const cwd = "/Volumes/My SSD/work/.claude/worktrees/feature_x";
    const encoded = "-Volumes-My-SSD-work--claude-worktrees-feature-x";
    const file = write(path.join(home, ".claude", "projects", encoded, "s.jsonl"), "{}\n");
    utimesSync(file, 1_800_000_000, 1_800_000_000);
    const result = run("locate-session-transcript.mjs", ["--home", home, "--cwd", cwd]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { ok: true, path: file, source: "claude-code" });
  });

  it("reports not_found when no store has a transcript", () => {
    const home = tempDir("sf-loc-home-");
    const result = run("locate-session-transcript.mjs", ["--home", home, "--cwd", "/nowhere"]);
    assert.equal(result.status, 1);
    assert.deepEqual(result.json, { ok: false, reason: "not_found" });
  });
});

describe("check-catalog-keys.mjs", () => {
  const io = "io: { input: { schema: { type: object, required: [topic], properties: { topic: { type: string } } } }, output: { schema: { type: object } } }\n";

  it("flags stage-file typos, pipeline-level browser, bad ids and task input that misses entry io.input", () => {
    const dir = tempDir("sf-keys-");
    const pipeline = write(path.join(dir, "demo.pipeline.yaml"), [
      "id: demo",
      "model: test/model",
      "description: ignored",
      "browser: { profile: work }",
      "stages:",
      "  - id: Draft_One",
      "    uses: ./draft.yaml",
      "",
    ].join("\n"));
    write(path.join(dir, "draft.yaml"), `id: Draft_One\nsystem_prompt: hi\ngate_kind: [confirm]\n${io}`);
    const task = write(path.join(dir, "demo.task.yaml"), "id: demo\ngoal: Draft\nnotes: x\ninput: { topic: 5 }\n");
    const result = run("check-catalog-keys.mjs", ["--pipeline", pipeline, "--task", task]);
    assert.equal(result.status, 1, result.stderr);
    const codes = result.json.findings.map((f) => f.code).sort();
    assert.deepEqual(codes, [
      "lint.id_format",
      "lint.id_format",
      "lint.pipeline_browser_ignored",
      "lint.task_input_mismatch",
      "lint.unknown_pipeline_key",
      "lint.unknown_stage_key",
      "lint.unknown_task_key",
    ]);
    const typo = result.json.findings.find((f) => f.code === "lint.unknown_stage_key");
    assert.match(typo.message, /Did you mean "gate_kinds"/);
  });

  it("passes a clean package", () => {
    const dir = tempDir("sf-keys-");
    const pipeline = write(path.join(dir, "demo.pipeline.yaml"), "id: demo\nmodel: test/model\nstages:\n  - id: draft\n    uses: ./draft.yaml\n");
    write(path.join(dir, "draft.yaml"), `id: draft\nsystem_prompt: hi\n${io}`);
    const task = write(path.join(dir, "demo.task.yaml"), "id: demo\ngoal: Draft\ninput: { topic: Calendars }\n");
    const result = run("check-catalog-keys.mjs", ["--pipeline", pipeline, "--task", task]);
    assert.equal(result.status, 0, JSON.stringify(result.json));
    assert.equal(result.json.ok, true);
  });
});
