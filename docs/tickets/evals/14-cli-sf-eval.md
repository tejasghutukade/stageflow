# 14: CLI `sf eval`

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 13

## Why this story exists

Evals must be runnable from a terminal and from automation with a stable JSON and exit-code contract, the same capability as the console (A5, the repo's CLI pattern).

## Read first

- [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md): "CLI" (commands, flags, exit codes, JSON document) and P8 in the [epic](../../specs/evals.md).
- `src/cli/triggerCommand.ts` and `src/cli/runStageCommand.ts` (argument parsing style, `--json`, usage text, `hostClient` use), `src/cli/hostClient.ts`, `src/cli/resolveCliProjectRoot.ts`, `src/cli.ts` (the command list near the top and dispatch near the `trigger` branch), `src/cli/validateCommand.ts`.
- `docs/ci.md` (JSON and exit-code conventions, validate-shaped output on validation failure) and `docs/cli-reference.md` (documentation is story 24, but match the style now).
- Tests: `tests/cli.trigger.test.ts`, `tests/cli.validate.test.ts`, the CLI test for `run-stage`.

## Decisions already made (do not revisit)

Commands, flags, defaults (waits by default; `--no-wait`), exit codes (`0` only for a completed run that passed; `1` otherwise; usage errors exit `1` like other `sf` commands unless the repo's convention differs, in which case follow the repo and note it), and the `--json` documents are in api-cli-mcp.md. The CLI talks to the Host over HTTP (ensuring the shared service like `sf run-stage` does) and never opens the run store directly. Progress goes to stderr, results to stdout. The engine commands call the story 10 library directly (they do not need the Host).

## What to build

1. **`src/cli/evalCommand.ts`:** `EVAL_USAGE`, `runEvalCommand(args, io, deps)` implementing every subcommand in api-cli-mcp.md: `list`, `show`, `validate`, `run`, `runs` (+ `show`, `cancel`, `delete`), `compare`, `datasets`, `engine status`, `engine install`.
2. **`hostClient.ts` additions:** `httpListEvals`, `httpGetEval`, `httpValidateEval`, `httpStartEvalRun`, `httpGetEvalRun`, `httpCancelEvalRun`, `httpListEvalRuns`, `httpDeleteEvalRun`, `httpCompareEvalRuns`, `httpListDatasets`, following the existing function style.
3. **`sf eval validate`:** offline-capable like `sf validate` (it can call the validator directly); same output text and `--json` shape as `sf validate` for the eval category, `--strict` supported.
4. **`sf eval run` flow:** resolve `<id|path>` to an eval id, `POST …/runs` (with `started_via: "cli"`), then unless `--no-wait` poll `GET …/runs/:n` every 1.5 s (print `results_done/results_total` and cost to stderr when it is a TTY), print the result per `--json` or a human summary (pass rate with CI, threshold, results executed/passed/errored, reliability, cost, fingerprint, the console URL). Ctrl-C cancels the eval run (`POST …/cancel`) before exiting `1`.
5. **Wire into `src/cli.ts`:** command list, dispatch, and the top-level usage text.
6. **Tests** with the existing CLI test harness and a fake Host/HTTP layer (as the trigger and run-stage CLI tests do): each subcommand's output and exit code; `run` exit `0` on passed, `1` on below threshold, failed, cancelled, `budget_stopped`, validation failure, `EVAL_ENGINE_UNAVAILABLE`; `--no-wait` prints the id and exits `0`; `--json` documents match the spec field-for-field; `--case`/`--tag` repeatable; `--max-cost` parsing; `engine install` calls the story 10 installer with a fake npm.

## Acceptance

- [ ] `sf eval run <id> --json` on a passing fake run prints the documented document with `outcome: "passed"` and exits `0`; on a run below threshold prints `below_threshold` and exits `1`.
- [ ] Validation failure prints a validate-shaped document with no `eval_run_id` and exits `1`.
- [ ] `--no-wait` exits `0` immediately after start, printing `eval_run_id`.
- [ ] `sf eval list --json`, `show --json`, `runs --json`, `runs show --json`, `compare --json` print the same objects as the API.
- [ ] Ctrl-C (simulated) cancels the eval run and exits `1`.
- [ ] `sf eval engine status --json` matches the documented shape; `install` installs through the story 10 library.
- [ ] Unknown flags or missing arguments print the usage text and exit `1`.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Documentation (story 24). MCP (15). CI integration and scheduling.

## Open questions

_(agent fills; stop and ask the owner)_
