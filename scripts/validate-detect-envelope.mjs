#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].map(String).sort();
  return deepEqual(sa, sb);
}

function findNewestChangesJson(cwd) {
  const runsRoot = path.join(cwd, ".stageflow", "runs");
  let newest = null;
  let newestMtime = -1;

  let runDirs;
  try {
    runDirs = readdirSync(runsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }

  for (const run of runDirs) {
    const attemptsRoot = path.join(
      runsRoot,
      run.name,
      "stages",
      "detect-changes",
      "attempts",
    );
    let attemptDirs;
    try {
      attemptDirs = readdirSync(attemptsRoot, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
    } catch {
      continue;
    }
    for (const attempt of attemptDirs) {
      const candidate = path.join(attemptsRoot, attempt.name, "artifacts", "changes.json");
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.mtimeMs >= newestMtime) {
          newestMtime = st.mtimeMs;
          newest = candidate;
        }
      } catch {
        // skip missing
      }
    }
  }
  return newest;
}

const cwd = process.cwd();
const ciPath = path.resolve(cwd, process.env.CI_CONTEXT_FILE || "ci-context.json");
const changesPath = findNewestChangesJson(cwd);

if (!changesPath) {
  fail(
    "validate-detect-envelope: no changes.json found under .stageflow/runs/*/stages/detect-changes/attempts/*/artifacts/",
  );
}

let ci;
let changes;
try {
  ci = JSON.parse(await readFile(ciPath, "utf8"));
} catch (err) {
  fail(`validate-detect-envelope: failed to read/parse ${ciPath}: ${err.message}`);
}
try {
  changes = JSON.parse(await readFile(changesPath, "utf8"));
} catch (err) {
  fail(`validate-detect-envelope: failed to read/parse ${changesPath}: ${err.message}`);
}

if (String(changes.pr_number) !== String(ci.pr_number)) {
  fail(
    `validate-detect-envelope: pr_number mismatch: changes=${JSON.stringify(changes.pr_number)} ci=${JSON.stringify(ci.pr_number)}`,
  );
}
if (changes.base_ref !== ci.base_ref) {
  fail(
    `validate-detect-envelope: base_ref mismatch: changes=${JSON.stringify(changes.base_ref)} ci=${JSON.stringify(ci.base_ref)}`,
  );
}
if (changes.head_sha !== ci.head_sha) {
  fail(
    `validate-detect-envelope: head_sha mismatch: changes=${JSON.stringify(changes.head_sha)} ci=${JSON.stringify(ci.head_sha)}`,
  );
}
if (changes.content_hash !== ci.content_hash) {
  fail(
    `validate-detect-envelope: content_hash mismatch: changes=${JSON.stringify(changes.content_hash)} ci=${JSON.stringify(ci.content_hash)}`,
  );
}

if (!deepEqual(changes.changed_files, ci.relevant_files)) {
  if (sortedEqual(changes.changed_files, ci.relevant_files)) {
    fail(
      "validate-detect-envelope: changed_files matches relevant_files as a set but order differs; copy relevant_files as-is",
    );
  }
  fail(
    `validate-detect-envelope: changed_files !== relevant_files\n  changes: ${JSON.stringify(changes.changed_files)}\n  ci:      ${JSON.stringify(ci.relevant_files)}`,
  );
}

if (!deepEqual(changes.diagram_types, ci.diagram_types)) {
  fail(
    `validate-detect-envelope: diagram_types mismatch\n  changes: ${JSON.stringify(changes.diagram_types)}\n  ci:      ${JSON.stringify(ci.diagram_types)}`,
  );
}

if (changes.change_summary !== ci.change_summary) {
  fail(
    `validate-detect-envelope: change_summary mismatch: changes=${JSON.stringify(changes.change_summary)} ci=${JSON.stringify(ci.change_summary)}`,
  );
}

if (ci.expected_fork_choice !== undefined) {
  if (!deepEqual(changes.fork_choice, ci.expected_fork_choice)) {
    fail(
      `validate-detect-envelope: fork_choice !== expected_fork_choice\n  changes: ${JSON.stringify(changes.fork_choice)}\n  ci:      ${JSON.stringify(ci.expected_fork_choice)}`,
    );
  }
}

const diagramTypes = changes.diagram_types;
const expectedFork =
  Array.isArray(diagramTypes) && diagramTypes.length === 0 ? [] : ["author-diagrams"];
if (!deepEqual(changes.fork_choice, expectedFork)) {
  fail(
    `validate-detect-envelope: fork_choice must be ${JSON.stringify(expectedFork)} when diagram_types=${JSON.stringify(diagramTypes)}; got ${JSON.stringify(changes.fork_choice)}`,
  );
}

console.log(
  `validate-detect-envelope: OK pr=${changes.pr_number} diagrams=${JSON.stringify(changes.diagram_types)} fork=${JSON.stringify(changes.fork_choice)} file=${changesPath}`,
);
process.exit(0);
