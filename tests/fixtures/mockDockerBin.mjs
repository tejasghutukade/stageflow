#!/usr/bin/env node
// Minimal stand-in for the `docker` binary, used by container-mode launcher
// tests. Ignores the `run --rm --name ... -v ... -w ... -e ... <image>`
// plumbing docker itself would consume and just behaves like
// mockStageWorker.mjs based on `--stage-id` + MOCK_* env vars, so the same
// delay/exit-code/stderr knobs work whether the launcher spawned this via
// fork() or via a fake "docker".
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workerPath = fileURLToPath(
  new URL("./mockStageWorker.mjs", import.meta.url),
);
const result = spawnSync(process.execPath, [workerPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
