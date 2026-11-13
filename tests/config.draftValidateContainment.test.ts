import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateDraftPackage, type DraftPackage } from "../src/config/draftPackage.js";

const MODEL = "anthropic/claude-sonnet-4-5";
const stageBody = (id: string) => ({
  id,
  system_prompt: "x",
  model: MODEL,
  io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
});

let tmp: string;
let savedTmp: string | undefined;

beforeEach(() => {
  // A private TMPDIR: everything validation writes must stay in its own temp folder under here, and be removed.
  tmp = mkdtempSync(path.join(os.tmpdir(), "sf-validate-tmp-"));
  savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
});

afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  rmSync(tmp, { recursive: true, force: true });
});

function draftWithStage(stagePath: string, pipelineId = "pool"): DraftPackage {
  return {
    pipeline: { id: pipelineId, stages: [{ id: "shared", uses: stagePath, entry: true }] },
    stages: [{ path: stagePath, body: stageBody("shared") }],
  } as DraftPackage;
}

describe("validateDraftPackage containment", () => {
  it("refuses a stage path or pipeline id that would write outside its temp folder", async () => {
    const escapeTarget = path.join(tmp, "pwned.yaml");
    const climbs = "../".repeat(40) + escapeTarget.replace(/^\//, "");
    const viaStage = await validateDraftPackage(draftWithStage(climbs), { cwd: tmp, projectRoot: tmp });
    expect(viaStage.ok).toBe(false);
    expect(viaStage.findings.some((f) => f.code === "pipeline.invalid_path")).toBe(true);

    const viaId = await validateDraftPackage(draftWithStage("stages/a.yaml", `../../../${path.basename(tmp)}/pid`), {
      cwd: tmp,
      projectRoot: tmp,
    });
    expect(viaId.ok).toBe(false);
    expect(viaId.findings.some((f) => f.code === "pipeline.invalid_path")).toBe(true);

    const absolute = await validateDraftPackage(draftWithStage(escapeTarget), { cwd: tmp, projectRoot: tmp });
    expect(absolute.ok).toBe(false);

    expect(readdirSync(tmp)).toEqual([]);
  });

  it("validates a shared ../stages path inside its own temp folder and leaves nothing behind", async () => {
    const result = await validateDraftPackage(draftWithStage("../stages/shared.yaml"), { cwd: tmp, projectRoot: tmp });
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
