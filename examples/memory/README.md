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

`file-card` adds one card. `update-card` replaces that card. `find-card` reads it, searches the current cards, and reads the cover without changing either. All three attach `notebook`. Run them in that order, after the memory exists. The cover runs above are optional. A stage cannot delete a card.

```bash
sf run \
  --pipeline examples/memory/file-card.pipeline.yaml \
  --task examples/memory/file-ticket.task.yaml

sf run \
  --pipeline examples/memory/find-card.pipeline.yaml \
  --task examples/memory/find-ticket.task.yaml

sf run \
  --pipeline examples/memory/update-card.pipeline.yaml \
  --task examples/memory/update-ticket.task.yaml

sf run \
  --pipeline examples/memory/find-card.pipeline.yaml \
  --task examples/memory/find-ticket.task.yaml
```

The first find should return the filed note for `TICKET-1842` and a search hit for `refund`. The second find should return the updated note. The cover text should be unchanged by these four runs. Add refuses a key that already exists, so a second `file-card` run of the same task fails. Update refuses a key that is missing.

`remember` and `recall` attach the same memory, so they can call the card tools too. Their tasks only use the cover. The prompt lists the memory id and its description, not the cover or any card body. The session never receives a filesystem path.

Search is a case-insensitive word scan of the current keys and bodies, at most 20 hits, snippet only.

## A desk with several cards

`desk` files every card in the task, updates only the focus key, then reads the cover and the other cards back. `desk-revisit` does that update on a later run, after the cards already exist. Both attach `new-notebook`. Create that memory in the console before the first run.

`desk-outage` uses a ticket id, a release path (`releases/2.4.1`), and an email. `desk-refund` uses a different ticket, an order path (`orders/4412/refund`), and a different email, so it can run beside the outage without sharing a key. Run each `desk` task once. A second run fails because add refuses a key that already exists.

```bash
sf run \
  --pipeline examples/memory/desk.pipeline.yaml \
  --task examples/memory/desk-outage.task.yaml

sf run \
  --pipeline examples/memory/desk-revisit.pipeline.yaml \
  --task examples/memory/desk-revisit-outage.task.yaml
```

After `desk-outage`, the release card should be the hold-the-deploy decision. `TICKET-1904` and `ada@example.com` should still be the original notes. The last stage's `cover_same` should be `yes`.

After `desk-revisit-outage`, the release card should be the rollback-finished note, and the previous copy in **Memories** should be the hold-the-deploy decision. The ticket and the email card should still be the original notes. `cover_same` should stay `yes`.

`desk-refund` is the same pipeline with a second set of keys. Run it on its own, not after those keys already exist. Search during that run looks for `reviewer`, which is only in the email card, while the card that gets updated is the order path.

The operator, in **Memories**, can list keys, open the `TICKET-1842` card, correct it, and delete it. Delete removes the current card and the previous copy and cannot be undone. The page shows the previous card copy and the previous cover text when they exist. The operator can edit the cover. The operator does not create cards; a session adds them. There is one previous copy, not a full history, and no restore action.

`sandbox-memory-bash` is the sandbox probe. It attaches `shared-notes` and its `probe` stage runs one bash command, then reports whether that command printed a `body.md` path. The task is `probe-bash`. Create `shared-notes` before running it. Edit the `probe` stage prompt in the pipeline file.

This directory is excluded from the repo-root catalog scan, because those commands fail until `notebook` exists.
