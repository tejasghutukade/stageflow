# Function manual pack

Three project functions and three pipelines for running the function kinds by hand. Each function starts with `export const access`. The host derives the capabilities. The YAML files do not repeat `capabilities` or `bindings`.

| Function | Kind | What it touches | Pipeline |
|----------|------|-----------------|----------|
| `report_gate` | verification | Reads `artifacts/report.json`. Requires `MIN_SCORE`. | `report-gate` |
| `lane_pick` | routing | Reads `payload.lane`. Optional `DEFAULT_LANE` when the envelope omits a lane. | `lane-pick` |
| `note_writer` | tool | Writes `artifacts/note.txt`. Optional `NOTE_LABEL` prefix. | `note-writer` |

The definitions live at the project root, `functions/<id>.function.yaml`.

## Commands

From the **repository git root**, with `MIN_SCORE` set in the shell that starts the run:

```bash
sf validate --pipeline examples/function-manual/report-gate.pipeline.yaml
sf validate --pipeline examples/function-manual/lane-pick.pipeline.yaml
sf validate --pipeline examples/function-manual/note-writer.pipeline.yaml

MIN_SCORE=70 DEFAULT_LANE=hold NOTE_LABEL=lab sf run \
  --pipeline examples/function-manual/report-gate.pipeline.yaml \
  --task examples/function-manual/report-gate.task.yaml
```

Swap the pipeline and task paths for `lane-pick` and `note-writer`. Each run calls a model.

On the operator console, open **Functions** to read the three definitions, then start each pipeline with its matching task. The container at `http://127.0.0.1:3900` already has `MIN_SCORE=70`, `DEFAULT_LANE=hold`, and `NOTE_LABEL=lab`.
