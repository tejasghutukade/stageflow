# Compaction eval harness

Offline, scenario-based scoring of compaction strategies (see `docs/plans/compaction-strategy.md`, phase 2).
A strategy turns the messages Pi would discard into a summary. The harness scores the summary against facts planted in synthetic transcripts, then asks the same model probe questions using only `summary + kept tail`.

## Run

```bash
npx tsx scripts/compaction-eval/run.ts --dry-run                      # no network, fake strategy
OPENROUTER_API_KEY=... npx tsx scripts/compaction-eval/run.ts \
  --scenario log-analysis --strategy baseline,focus --repeats 3 \
  --model openrouter/deepseek/deepseek-chat-v3.1 --max-cost-usd 0.60 --out /tmp/r.json
npx tsx scripts/compaction-eval/run.ts --existing-session /path/session.jsonl --strategy all   # size/cost only
```

Flags: `--scenario <id|family|all>`, `--strategy <ids,comma|all>`, `--model provider/model-id`, `--repeats N`, `--out file.json`, `--dry-run`, `--max-cost-usd` (default 1.00, aborts the run), `--seed N`, `--keep-tail N` (existing session).
Families: log-analysis, coding, research, operator-qa, repair, browser, project-agent.

Metrics per strategy x scenario (mean, min-max over repeats): fact recall (all, critical, early/mid/late), probe pass rate, secret leaks (must be 0), summary chars, cost (summary + probes).

## Add a scenario

1. Create `scenarios/<name>.ts` exporting `build<Name>(seed): Scenario`. Use `rng(seed)`, `Transcript` (`user`, `say`, `call`) and `fill(chars, makeLine, [[fraction, plantedLine]])` from `builder.ts`. Everything must be deterministic and at least 150k characters.
2. Finish with `buildScenario({...})`. It throws if a fact is missing, sits in the kept tail, or its declared `where` (early/mid/late by message index in the summarized region) is wrong, or a secret is not in the transcript.
3. Register it in `scenarios/index.ts`. `tests/compaction-eval.scenarios.test.ts` picks it up (size, determinism, all three positions).

Plant at least one fact past char 2000 of a tool result: Pi's `serializeConversation` cuts tool results at 2000 chars.

## Add a strategy

Implement `CompactionStrategy` (`types.ts`): `summarize({ messages, previousSummary?, model, signal })` returning `{ summary, usageCostUsd, tokensIn, tokensOut }`. `model.piModel/apiKey/headers/env/reserveTokens` are what Pi's `generateSummaryWithUsage` needs; `model.complete()` is a plain one-shot call. Register it in `strategies/index.ts` (`registerStrategy`, or add to the map). A strategy in `src/compaction/` is imported by a thin adapter file here.
`--dry-run` always uses `strategies/fake.ts` and an echo model.
