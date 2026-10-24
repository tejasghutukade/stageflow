import { describe, expect, it } from "vitest";
import type { EvalDefinition, EvalDetail } from "../../../api/evalTypes";
import type { ValidationFinding } from "../../../api/types";
import {
  afterSave,
  buildSaveBody,
  discard,
  draftDefaults,
  effectiveDefinition,
  evalDirOf,
  footerNote,
  isDirty,
  keepEditing,
  leafDiffCount,
  loadState,
  onFileChanged,
  onFocusFetched,
  reloadFromDisk,
  saveBlockReason,
  setDraft,
  setYamlText,
  shouldBlockLeave,
  switchToForm,
  switchToYaml,
  unsavedCount,
  unsavedLabel,
  withDataset,
  withDatasetFile,
  resolveRelative,
  sameFile,
  targetFromDefinition,
  withDefault,
  withJudge,
  withText,
} from "./editModel";
import { buildStageRows, moveGrader, removeGrader, replaceGrader } from "../newEval/wizardModel";

const DEF: EvalDefinition = {
  version: 1,
  id: "demo",
  name: "Demo",
  type: "capability",
  target: { kind: "stage", pipeline: "./p.pipeline.yaml", stage: "critique" },
  dataset: "./d.dataset.jsonl",
  defaults: { repeats: 2, pass_threshold: 0.8, max_cost_usd: 1 },
  graders: [
    { id: "a", type: "schema" },
    { id: "b", type: "rubric", rubric: "Be nice", scale: "pass_fail" },
    { id: "c", type: "field", checks: [{ path: "x", op: "equals", value: 1 }] },
  ],
};

function detail(over: Partial<EvalDetail> = {}): EvalDetail {
  return {
    id: "demo",
    path: "evals/demo.eval.yaml",
    file_hash: "h1",
    definition: structuredClone(DEF),
    yaml: "version: 1\nid: demo\n",
    findings: [],
    runs_count: 3,
    last_run: null,
    ...over,
  };
}

const err = (message: string): ValidationFinding => ({ severity: "error", code: "x", path: "", message, category: "eval", line: 2 });
const warn = (message: string): ValidationFinding => ({ severity: "warning", code: "y", path: "", message, category: "eval" });

describe("leafDiffCount", () => {
  it("is zero for equal values regardless of key order", () => {
    expect(leafDiffCount(DEF, { ...DEF, graders: DEF.graders, id: "demo" })).toBe(0);
    expect(leafDiffCount({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(0);
  });
  it("counts a changed default as one", () => {
    expect(leafDiffCount(DEF, withDefault(DEF, "repeats", 5))).toBe(1);
  });
  it("counts a rubric text edit as one", () => {
    const next = replaceGrader(DEF, 1, { ...DEF.graders[1]!, rubric: "Be kind" });
    expect(leafDiffCount(DEF, next)).toBe(1);
  });
  it("counts added and removed leaves", () => {
    expect(leafDiffCount(DEF, withText(DEF, "description", "hi"))).toBe(1);
    expect(leafDiffCount(DEF, withText(DEF, "name", ""))).toBe(1);
    expect(leafDiffCount(DEF, removeGrader(DEF, 0))).toBeGreaterThan(1);
  });
  it("counts a reorder as changed", () => {
    expect(leafDiffCount(DEF, moveGrader(DEF, 0, 2))).toBeGreaterThan(0);
  });
  it("tells a string from a number", () => {
    expect(leafDiffCount({ a: 1 }, { a: "1" })).toBe(1);
  });
  it("treats null as empty", () => {
    expect(leafDiffCount(null, { a: 1, b: { c: 2 } })).toBe(2);
  });
});

describe("loadState and unsaved count", () => {
  it("starts clean in form mode", () => {
    const s = loadState(detail());
    expect(s.mode).toBe("form");
    expect(unsavedCount(s)).toBe(0);
    expect(isDirty(s)).toBe(false);
    expect(unsavedLabel(0)).toBeNull();
  });
  it("opens an unreadable file in YAML mode", () => {
    const s = loadState(detail({ definition: null, yaml: "bad: [" }));
    expect(s.mode).toBe("yaml");
    expect(s.yamlText).toBe("bad: [");
    expect(isDirty(s)).toBe(false);
  });
  it("labels the count", () => {
    expect(unsavedLabel(1)).toBe("1 unsaved change");
    expect(unsavedLabel(4)).toBe("4 unsaved changes");
    expect(unsavedLabel(null)).toBe("Unsaved changes");
  });
  it("counts form edits", () => {
    const s = setDraft(loadState(detail()), (d) => withDefault(d, "pass_threshold", 0.9));
    expect(unsavedCount(s)).toBe(1);
    expect(isDirty(s)).toBe(true);
  });
  it("uses the parsed YAML in YAML mode once edited", () => {
    let s = switchToYaml(loadState(detail()), "version: 1\n");
    expect(isDirty(s)).toBe(false);
    s = setYamlText(s, "version: 1\n# note\n");
    expect(isDirty(s)).toBe(true);
    expect(effectiveDefinition(s, null)).toBeNull();
    expect(unsavedCount(s, null)).toBeNull();
    expect(unsavedCount(s, withDefault(DEF, "repeats", 9))).toBe(1);
  });
});

describe("mode gate", () => {
  it("switches to YAML with the derived text", () => {
    const s = switchToYaml(loadState(detail()), "derived\n");
    expect(s.mode).toBe("yaml");
    expect(s.yamlText).toBe("derived\n");
  });
  it("falls back to the file text when nothing is derived yet", () => {
    expect(switchToYaml(loadState(detail()), "").yamlText).toBe("version: 1\nid: demo\n");
  });
  it("refuses Form while the YAML has errors", () => {
    const s = switchToYaml(loadState(detail()), "x");
    const res = switchToForm(s, { findings: [err("bad"), warn("meh")], definition: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.findings).toHaveLength(1);
  });
  it("refuses Form when no definition came back", () => {
    const s = switchToYaml(loadState(detail()), "x");
    expect(switchToForm(s, { findings: [], definition: null }).ok).toBe(false);
  });
  it("accepts Form for valid YAML and takes the parsed values", () => {
    const s = switchToYaml(loadState(detail()), "x");
    const res = switchToForm(s, { findings: [warn("meh")], definition: withDefault(DEF, "repeats", 7) });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.mode).toBe("form");
      expect(res.state.draft?.defaults?.repeats).toBe(7);
      expect(unsavedCount(res.state)).toBe(1);
    }
  });
});

describe("save", () => {
  const free = { dirty: true, errors: 0, localProblems: 0, saving: false, validating: false };
  it("builds a definition body in form mode and a yaml body in YAML mode", () => {
    const s = setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4));
    expect(buildSaveBody(s)).toEqual({ definition: s.draft, base_hash: "h1" });
    const y = setYamlText(switchToYaml(loadState(detail()), "a\n"), "b\n");
    expect(buildSaveBody(y)).toEqual({ yaml: "b\n", base_hash: "h1" });
  });
  it("blocks on errors, not warnings", () => {
    const s = loadState(detail());
    expect(saveBlockReason(s, { ...free, errors: 1 })).toBe("Fix the errors first");
    expect(saveBlockReason(s, { ...free, localProblems: 1 })).toBe("Fix the errors first");
    expect(saveBlockReason(s, free)).toBeNull();
  });
  it("blocks when clean, saving or checking", () => {
    const s = loadState(detail());
    expect(saveBlockReason(s, { ...free, dirty: false })).toBe("No changes to save");
    expect(saveBlockReason(s, { ...free, saving: true })).toBe("Saving…");
    expect(saveBlockReason(s, { ...free, validating: true })).toBe("Checking the draft…");
  });
  it("adopts the response and returns to zero unsaved changes", () => {
    const dirty = setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4));
    const saved = afterSave(dirty, detail({ file_hash: "h2", definition: dirty.draft, yaml: "new\n" }));
    expect(saved.fileHash).toBe("h2");
    expect(unsavedCount(saved)).toBe(0);
    expect(isDirty(saved)).toBe(false);
    expect(saved.conflict).toBe("none");
  });
  it("keeps YAML mode after saving from YAML mode", () => {
    const y = setYamlText(switchToYaml(loadState(detail()), "a\n"), "b\n");
    const saved = afterSave(y, detail({ file_hash: "h2", yaml: "b\n" }));
    expect(saved.mode).toBe("yaml");
    expect(isDirty(saved)).toBe(false);
  });
});

describe("conflict machine", () => {
  const dirty = () => setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4));
  it("FILE_CHANGED opens the dialog and blocks Save", () => {
    const s = onFileChanged(dirty());
    expect(s.conflict).toBe("dialog");
    expect(saveBlockReason(s, { dirty: true, errors: 0, localProblems: 0, saving: false, validating: false })).toBe("Reload from disk before saving");
  });
  it("Keep editing keeps the draft and Save stays blocked", () => {
    const s = keepEditing(onFileChanged(dirty()));
    expect(s.conflict).toBe("blocked");
    expect(s.draft?.defaults?.repeats).toBe(4);
    expect(saveBlockReason(s, { dirty: true, errors: 0, localProblems: 0, saving: false, validating: false })).not.toBeNull();
  });
  it("Reload from disk replaces the draft and unblocks", () => {
    const s = reloadFromDisk(keepEditing(onFileChanged(dirty())), detail({ file_hash: "h9" }));
    expect(s.conflict).toBe("none");
    expect(s.fileHash).toBe("h9");
    expect(unsavedCount(s)).toBe(0);
  });
});

describe("focus handling", () => {
  it("does nothing when the hash is unchanged", () => {
    const s = loadState(detail());
    const out = onFocusFetched(s, detail(), false);
    expect(out.state).toBe(s);
    expect(out.reloaded).toBe(false);
  });
  it("reloads silently when clean", () => {
    const out = onFocusFetched(loadState(detail()), detail({ file_hash: "h2", yaml: "z\n" }), false);
    expect(out.reloaded).toBe(true);
    expect(out.state.fileHash).toBe("h2");
  });
  it("shows the banner when dirty, once per hash", () => {
    const s = setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4));
    const first = onFocusFetched(s, detail({ file_hash: "h2" }), true);
    expect(first.reloaded).toBe(false);
    expect(first.state.externalChange).toBe("h2");
    expect(first.state.draft?.defaults?.repeats).toBe(4);
    const again = onFocusFetched(first.state, detail({ file_hash: "h2" }), true);
    expect(again.state).toBe(first.state);
  });
  it("stays quiet after Keep editing", () => {
    const s = keepEditing(setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4)));
    expect(onFocusFetched(s, detail({ file_hash: "h2" }), true).state).toBe(s);
  });
});

describe("discard and leave", () => {
  it("discard restores the loaded definition and text", () => {
    const s = setYamlText(setDraft(loadState(detail()), (d) => withDefault(d, "repeats", 4)), "q");
    const d = discard(s);
    expect(unsavedCount(d)).toBe(0);
    expect(d.yamlText).toBe(d.fileText);
  });
  it("blocks leaving the page only when dirty and going elsewhere", () => {
    expect(shouldBlockLeave(false, "demo", "#/evals")).toBe(false);
    expect(shouldBlockLeave(true, "demo", "#/evals")).toBe(true);
    expect(shouldBlockLeave(true, "demo", "#/evals/demo/edit")).toBe(false);
    expect(shouldBlockLeave(true, "demo", "#/evals/demo/edit?openRun=1")).toBe(false);
    expect(shouldBlockLeave(true, "demo", "#/evals/other/edit")).toBe(true);
  });
});

describe("form edits and copy", () => {
  it("judge can be set and cleared", () => {
    const set = withJudge(DEF, "m/x");
    expect(set.defaults?.judge).toBe("m/x");
    expect("judge" in (withJudge(set, null).defaults ?? {})).toBe(false);
  });
  it("draftDefaults falls back for missing values", () => {
    const d = draftDefaults({ ...DEF, defaults: {} }, { repeats: 3, passThreshold: 0.8, maxCostUsd: 2 });
    expect(d).toEqual({ repeats: 3, passThreshold: 0.8, maxCostUsd: 2, judge: null });
  });
  it("sets the dataset path", () => {
    expect(withDataset(DEF, "../datasets/x.jsonl").dataset).toBe("../datasets/x.jsonl");
  });
  it("resolves relative paths", () => {
    expect(resolveRelative("evals", "../datasets/x.jsonl")).toBe("datasets/x.jsonl");
    expect(resolveRelative("evals", "./d.jsonl")).toBe("evals/d.jsonl");
    expect(sameFile("evals/./a", "evals/a")).toBe(true);
  });
  it("writes a dataset path relative to the eval file", () => {
    expect(withDatasetFile(DEF, "evals", "datasets/x.dataset.jsonl").dataset).toBe("../datasets/x.dataset.jsonl");
    expect(withDatasetFile(DEF, "evals", "evals/d.dataset.jsonl").dataset).toBe("d.dataset.jsonl");
  });
  it("finds the stage a definition points at", () => {
    const rows = buildStageRows(
      [
        { id: "p", path: "evals/p.pipeline.yaml", stages: [{ id: "critique", uses_path: "stages/critique.stage.yaml" }] },
        { id: "q", path: "other/q.pipeline.yaml", stages: [{ id: "critique" }] },
      ] as never,
      new Set(),
    );
    const hit = targetFromDefinition(rows, DEF, "evals");
    expect(hit?.pipelinePath).toBe("evals/p.pipeline.yaml");
    expect(hit?.stageId).toBe("critique");
    const byFile = targetFromDefinition(rows, { ...DEF, target: { kind: "stage", file: "../stages/critique.stage.yaml" } }, "evals");
    expect(byFile?.kind).toBe("file");
    expect(targetFromDefinition(rows, { ...DEF, target: { kind: "stage", pipeline: "./nope.yaml", stage: "x" } }, "evals")).toBeNull();
  });
  it("derives the eval directory", () => {
    expect(evalDirOf("evals/demo.eval.yaml")).toBe("evals");
    expect(evalDirOf("demo.eval.yaml")).toBe(".");
  });
  it("words the footer with the past-run count", () => {
    expect(footerNote("evals/demo.eval.yaml", 0)).toBe("Saving rewrites evals/demo.eval.yaml.");
    expect(footerNote("evals/demo.eval.yaml", 1)).toBe("Saving rewrites evals/demo.eval.yaml. The 1 past run keeps the version it used.");
    expect(footerNote("evals/demo.eval.yaml", 5)).toContain("The 5 past runs keep the version they used.");
  });
});
