# compaction-stress

A three-stage incident postmortem whose first stage must read about 1 MB of logs (12 shards)
through a ~128k-163k context window, so its session compacts several times. It checks that a
stage still emits a correct envelope after compaction and that the next stage uses it.

## Run

1. Generate the evidence: `node examples/compaction-stress/generate-evidence.mjs <dir>`
   (also writes `<dir>.expected.json`, the ground truth, outside the checkout).
2. Make `<dir>` the task checkout (`/data/evidence` in the Docker recipe; see
   `docker-compose.compaction-stress.yml`). It must be a plain directory, not a mount.
3. Start `compaction-stress` in the console, or `sf run`.
4. Check the result: `node examples/compaction-stress/check-run.mjs <runId> <dir>.expected.json`.

## If a model leaks tool calls

Some OpenRouter providers return a model's tool calls as plain text (for example `<｜tool▁calls▁begin｜>` in the reasoning), so a stage ends with `missing emit_stage_envelope`. Pin the providers in the Host's `$STAGEFLOW_HOME/agent/models.json`:

```json
{ "providers": { "openrouter": { "modelOverrides": { "deepseek/deepseek-chat-v3.1": {
  "compat": { "openRouterRouting": { "order": ["SiliconFlow", "CoreWeave"], "allow_fallbacks": false } } } } } } }
```

## What to look for

- The stage inspector's Context row climbs and drops after each compaction.
- `read`/`bash` results beyond the per-turn cap are replaced by "output not returned" notices.
- The envelope matches `expected.json`: incident id, build, retry policy, failed checkouts,
  duration, recovery time, all 12 shards, and the cert-expiry red herring in `ruled_out`.
