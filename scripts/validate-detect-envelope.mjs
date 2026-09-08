#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CANDIDATE_ENVELOPE = "completion-candidate-envelope.json";

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

const attemptDir = path.dirname(path.dirname(changesPath));
const envelopePath = path.join(attemptDir, CANDIDATE_ENVELOPE);

let ci;
let changes;
let envelope;
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
try {
  envelope = JSON.parse(await readFile(envelopePath, "utf8"));
} catch (err) {
  fail(
    `validate-detect-envelope: failed to read/parse candidate envelope at ${envelopePath}: ${err.message}`,
  );
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

const diagramTypes = changes.diagram_types;
const expectedFork =
  Array.isArray(diagramTypes) && diagramTypes.length === 0 ? [] : ["author-diagrams"];

if (ci.expected_fork_choice !== undefined) {
  if (!deepEqual(ci.expected_fork_choice, expectedFork)) {
    fail(
      `validate-detect-envelope: ci.expected_fork_choice inconsistent with diagram_types\n  expected_fork_choice: ${JSON.stringify(ci.expected_fork_choice)}\n  derived: ${JSON.stringify(expectedFork)}`,
    );
  }
}

if (!deepEqual(changes.fork_choice, expectedFork)) {
  fail(
    `validate-detect-envelope: changes.json fork_choice must be ${JSON.stringify(expectedFork)}; got ${JSON.stringify(changes.fork_choice)}`,
  );
}

if (!deepEqual(envelope.fork_choice, expectedFork)) {
  fail(
    `validate-detect-envelope: envelope.fork_choice must be ${JSON.stringify(expectedFork)}; got ${JSON.stringify(envelope.fork_choice)}`,
  );
}

const payload = envelope.payload ?? {};
for (const key of [
  "pr_number",
  "base_ref",
  "head_sha",
  "content_hash",
  "change_summary",
]) {
  if (String(payload[key] ?? "") !== String(changes[key] ?? "")) {
    fail(
      `validate-detect-envelope: envelope.payload.${key} !== changes.${key}`,
    );
  }
}
if (!deepEqual(payload.changed_files, changes.changed_files)) {
  fail("validate-detect-envelope: envelope.payload.changed_files !== changes.changed_files");
}
if (!deepEqual(payload.diagram_types, changes.diagram_types)) {
  fail("validate-detect-envelope: envelope.payload.diagram_types !== changes.diagram_types");
}

console.log(
  `validate-detect-envelope: OK pr=${changes.pr_number} diagrams=${JSON.stringify(changes.diagram_types)} fork=${JSON.stringify(envelope.fork_choice)} file=${changesPath}`,
);
process.exit(0);
