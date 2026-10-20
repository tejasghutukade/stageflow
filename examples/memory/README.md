# memory

Two pipelines share one memory, `notebook`, in the data directory. `remember` adds a line to the cover page. `recall` only reads the cover, so a later run can see what an earlier run wrote. `notebook` is the memory id. It is not a card key.

Create the memory before either pipeline runs. A run does not create it. `missing.pipeline.yaml` names an id that is not there, so validate fails and a run does not start.

## Create the memory

With `sf ui` running:

```bash
curl -sS -X POST http://127.0.0.1:3847/api/memories \
  -H 'Origin: http://127.0.0.1:3847' \
  -H 'Content-Type: application/json' \
  -d '{"id":"notebook","description":"Lines this pipeline has already recorded."}'
```

Or use **Memories** in the console. The id is `notebook`. `memory.yaml` stays version 1. The cover is `body.md`. Cards live beside it.

## Run the cover

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

The cover is `$STAGEFLOW_HOME/memories/notebook/body.md`. After the two remember runs it should contain both lines (`Ada was sourced.` and `Grace was shortlisted.`). Recall's envelope `page` should match that file. Replacing the cover does not delete cards.

```bash
sf validate --pipeline examples/memory/missing.pipeline.yaml --strict
```

That command fails with `pipeline.memory_unavailable`.

## Cards

`remember` and `recall` attach `notebook`, so on the Pi backend each of those stages can also call `add_memory_card`, `update_memory_card`, `read_memory_card`, and `search_memory_cards`, plus `read_memory` and `replace_memory` for the cover. The tasks above only use the cover. The prompt lists the memory id and its description, not the cover or any card body. The session never receives a filesystem path.

A card is a note for one subject. The key is that subject's own id. To record a ticket on one run and read it on a later run, keep the same memory id and use a ticket id as the key:

1. On the first run, call `add_memory_card` with memory `notebook`, key `TICKET-1842`, and the note. Add refuses that key if the card already exists.
2. On a later run, call `read_memory_card` with memory `notebook` and key `TICKET-1842`. The body is the note from the earlier run.

A later change to that card uses `update_memory_card` with the same memory and key. Update refuses a key that is missing. `search_memory_cards` with memory `notebook` and a query is a case-insensitive word scan of the current keys and bodies, at most 20 hits, snippet only. A stage cannot delete a card and cannot read the previous copy.

The operator, in **Memories**, can list keys, open the `TICKET-1842` card, correct it, and delete it. Delete removes the current card and the previous copy and cannot be undone. The page shows the previous card copy and the previous cover text when they exist. The operator can edit the cover. The operator does not create cards; a session adds them. There is one previous copy, not a full history, and no restore action.

This directory is excluded from the repo-root catalog scan, because those commands fail until `notebook` exists.
