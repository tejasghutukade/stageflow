# Function verification

One stage whose after-phase check is the project function `score_check`. The function reads `report.json` from the attempt artifacts and compares `score` with the bound `MIN_SCORE`.

The definition lives at the project root, `functions/score_check.function.js`, because a function file is project-owned. Its source starts with `export const access`, which derives a read of the artifacts root (`artifacts`) and the env alias `MIN_SCORE` (`env_min_score`). The file does not repeat `capabilities` or `bindings`. The pipeline grants those two derived ids.

## What this demonstrates

- A verification is `kind: verification` and `export default function execute` (async is fine).
- `export const access` is the first statement. `context.artifacts.readJson("report.json")` uses the artifacts grant.
- A stage check is `type: function` plus `function` on the stage body. Omitted `when` is the after phase.
- Each derived capability needs a matching grant. The file grant repeats `root` and `path` (`path: ""` is the artifacts root). The env grant is the capability id.

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/function-verify/score-check.pipeline.yaml
sf run \
  --pipeline examples/function-verify/score-check.pipeline.yaml \
  --task examples/function-verify/score-check.task.yaml
```

Validate should succeed. The run calls a model, writes `report.json`, and then runs the function. `MIN_SCORE` has to be set in the host process environment before that check. A missing required binding fails the check before the function body runs.

Open **Functions** in the operator console to read the revision, or attach this check from the pipeline inspector.
