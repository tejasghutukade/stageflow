# memory

Two pipelines share one page, `notebook`, in the data directory. `remember` adds a line. `recall` only reads the page, so a later run can see what an earlier run wrote.

Create the memory before either pipeline runs. A run does not create it. `missing.pipeline.yaml` names an id that is not there, so validate fails and a run does not start.

## Create the page

With `sf ui` running:

```bash
curl -sS -X POST http://127.0.0.1:3847/api/memories \
  -H 'Origin: http://127.0.0.1:3847' \
  -H 'Content-Type: application/json' \
  -d '{"id":"notebook","description":"Lines this pipeline has already recorded."}'
```

Or use **Memories** in the console. The id is `notebook`.

## Run

From the repository root, after the memory exists:

```bash
sf validate --pipeline examples/memory/remember.pipeline.yaml --strict
sf run \
  --pipeline examples/memory/remember.pipeline.yaml \
  --task examples/memory/remember-ada.task.yaml

sf run \
  --pipeline examples/memory/remember.pipeline.yaml \
  --task examples/memory/remember-grace.task.yaml

sf run \
  --pipeline examples/memory/recall.pipeline.yaml \
  --task examples/memory/recall.task.yaml
```

The page is `$STAGEFLOW_HOME/memories/notebook/body.md`. After the two remember runs it should contain both lines. Recall's envelope `page` should match that file.

```bash
sf validate --pipeline examples/memory/missing.pipeline.yaml --strict
```

That command fails with `pipeline.memory_unavailable`.

This directory is excluded from the repo-root catalog scan, because those commands fail until `notebook` exists.
