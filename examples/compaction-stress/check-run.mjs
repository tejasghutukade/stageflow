#!/usr/bin/env node
// Compares a finished compaction-stress run with the ground truth.
// Usage: node check-run.mjs <runId> <expected.json> [baseUrl]
import { readFileSync } from "node:fs";

const [runId, expectedPath, base = "http://127.0.0.1:3850"] = process.argv.slice(2);
if (!runId || !expectedPath) {
  console.error("usage: check-run.mjs <runId> <expected.json> [baseUrl]");
  process.exit(2);
}
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const body = await (await fetch(`${base}/api/runs/${runId}`)).json();
const run = body.run ?? body;
const stage = (id) => run.stages.find((s) => s.stage_id === id);
const payload = (id) => stage(id)?.envelope?.payload ?? {};
const evidence = payload("collect-evidence");
const rootCause = payload("root-cause");
const post = payload("write-postmortem");
const compactions = (stage("collect-evidence")?.events ?? []).filter((e) => e.event === "context_usage");

const checks = [
  ["run succeeded", run.status === "succeeded"],
  ["incident id", evidence.incident_id === expected.incident_id],
  ["build", evidence.suspected_change?.build === expected.root_cause_build],
  ["flag", evidence.suspected_change?.flag === expected.root_cause_flag],
  [
    "retry policy",
    evidence.suspected_change?.retry_policy ===
      `max_attempts=${expected.retry_policy.max_attempts} backoff=${expected.retry_policy.backoff} jitter=${expected.retry_policy.jitter}`,
  ],
  ["failed checkouts", evidence.impact?.failed_checkouts === expected.failed_checkouts],
  ["duration", evidence.impact?.duration_min === expected.duration_min],
  ["recovery time", String(evidence.impact?.recovery_ts ?? "").endsWith(expected.recovery_utc)],
  ["all 12 shards listed", (evidence.shards_reviewed ?? []).length >= 12],
  ["red herring ruled out", /cert/i.test(JSON.stringify(evidence.ruled_out ?? []))],
  ["root cause names the build or flag", [expected.root_cause_build, expected.root_cause_flag].some((x) => JSON.stringify(rootCause).includes(x))],
  ["root cause keeps the impact numbers", rootCause.impact?.failed_checkouts === expected.failed_checkouts],
  ["postmortem numbers match", post.failed_checkouts === expected.failed_checkouts && post.duration_min === expected.duration_min && String(post.recovery_ts ?? "").endsWith(expected.recovery_utc)],
  ["postmortem carries incident id", post.incident_id === expected.incident_id],
  ["postmortem has 4+ action items", (post.action_items ?? []).length >= 4],
  ["context was tracked", compactions.length > 0],
  [
    "context dropped at least once (compaction)",
    compactions.some((e, i) => i > 0 && e.percent < compactions[i - 1].percent - 20),
  ],
];
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
