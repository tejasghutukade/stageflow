# clonable-fanout

Dummy catalog for **manual operator-console testing** of clonable stage fan-out.
Work stages pause on a free-text gate, then on `ok <codeword>` write a small
`codeword.md` artifact and emit it on the envelope so you can check clone
paths on disk and in the Files column. **collect** must list every codeword
from the joined work envelopes.

Two pipelines:

| Pipeline | What it exercises |
|----------|-------------------|
| `fanout-demo` | skip, once, parallel N, sequential N, sequential fail-fast |
| `fanout-mix` | named sibling `side` starts with the first `work` clone |

## Prerequisites

Use this repo's CLI (`npm run build` / `npm run dev`) or a Stageflow release
that includes clonable fan-out. A globally installed `sf` from npm may lag.

- Node.js ≥ 20
- From repo root: `npm run build` and `npm run ui:build`
- Provider auth connected (`sf ui` → Settings → Providers). Stages use `cursor/auto`.

Run state lives in `<repo>/.stageflow` even if you start the console from a subdirectory.

## Terminal 1 — operator console

From the **repository git root**:

```bash
npm run build
npm run ui:build
npm run dev -- ui
```

Open `http://127.0.0.1:3847`. Browse should list **fanout-demo** and **fanout-mix**.

## Terminal 2 — start a run (repo root)

```bash
npm run dev -- validate --pipeline examples/clonable-fanout/fanout-demo.pipeline.yaml --strict
npm run dev -- run \
  --pipeline examples/clonable-fanout/fanout-demo.pipeline.yaml \
  --task examples/clonable-fanout/fanout-demo.task.yaml
```

Exit code `2` means waiting on operator input. Leave this terminal; do the rest in the console.

Start a **new run** for each scenario below. Do not reuse a finished run.

---

## Scenario A — parallel 3 (main UI check)

At **decide**, answer exactly:

```
parallel 3
```

### What to verify

1. Track shows three clone nodes labeled **work · 1**, **work · 2**, **work · 3** (not one shared `work` session).
2. `decide` and `collect` stay catalog ids.
3. All three work clones wait together (parallel). Today shows only the **first** waiter; open the run and click the other clones to answer them.
4. Select **work · 1**. Transcript header should say `work · 1`. Reply `ok maple`.
5. Select **work · 2**, reply `ok river`. Select **work · 3**, reply `ok pine`.
6. After each success, select that clone and check **Files**:
   - **Handoff envelope** opens the stage envelope (payload + artifact path).
   - A `codeword.md` row appears (meta = that instance id). Open it; body is
     the codeword alone (e.g. `maple`).
   - Wire chip should show **envelope · 1 file**.
7. On disk under `.stageflow/runs/<runId>/stages/` you should see
   `work~1/attempts/1/artifacts/codeword.md` (and `work~2`, `work~3`), **not**
   a shared `stages/work/artifacts/` folder for fan-out clones.
8. **collect** starts only after all three succeeded, then succeeds. Open its
   envelope: summary and `payload.codewords` should list `maple`, `river`,
   `pine` (clone-list order, not the order you answered). If any work clone
   fails, **collect** is skipped and the run fails; remaining clones still finish.

---

## Scenario B — skip

New run. At decide, answer:

```
skip
```

### What to verify

1. **work** never opens (status **skipped**).
2. **collect** is **skipped**.
3. Run outcome **succeeded**.

---

## Scenario C — once

New run. At decide, answer:

```
once
```

### What to verify

1. Exactly one **work** node, labeled `work` (catalog id, not `work · 1`).
2. Answer that node `ok solo`.
3. Files shows `codeword.md` under that stage; on disk path is
   `stages/work/attempts/1/artifacts/codeword.md` (catalog id, not `work~1`).
4. **collect** runs after that single work succeeds. Envelope lists `solo`.

---

## Scenario D — sequential 3

New run. At decide, answer:

```
sequential 3
```

### What to verify

1. Only **work · 1** starts. **work · 2** and **work · 3** stay pending while · 1 is waiting.
2. Answer **work · 1** `ok one`. Then **work · 2** becomes waiting. Answer `ok two`. Then **work · 3** `ok three`.
3. **collect** runs only after all three succeeded. Envelope lists `one`, `two`, `three`.

---

## Scenario E — sequential fail-fast (skipped leftovers)

New run. At decide, answer:

```
sequential 3
```

Answer **work · 1** `ok one`. Answer **work · 2** `fail`.

### What to verify

1. **work · 3** becomes **skipped** (selectable inspect node, not pending, not retriable).
2. **collect** does **not** run (skipped).
3. Ring/glyph for skipped is distinct from pending.

---

## Scenario F — mix with named sibling

```bash
npm run dev -- run \
  --pipeline examples/clonable-fanout/fanout-mix.pipeline.yaml \
  --task examples/clonable-fanout/fanout-mix.task.yaml
```

At **decide-mix**, answer exactly:

```
mix
```

### What to verify

1. **side** starts while the first **work** clone is still waiting — not after both clones finish.
2. Two work clones: **work · 1** and **work · 2**. Answer `ok alpha` and `ok beta`.
3. **collect** waits on the work clones only, then succeeds. Envelope lists
   `alpha`, `beta`.
4. **side** is a normal named sibling, not a clone label.

---

## Layout

```
examples/clonable-fanout/
  fanout-demo.pipeline.yaml
  fanout-demo.task.yaml
  fanout-mix.pipeline.yaml
  fanout-mix.task.yaml
  decide.yaml
  decide-mix.yaml
  work.yaml
  collect.yaml
  side.yaml
```

## References

- [YAML catalog — Clonable successors](../../docs/yaml-catalog.md#clonable-successors)
- [Envelopes — Clonable successors](../../docs/envelopes.md#clonable-successors)
- [HITL — selected instance vs Today first waiter](../../docs/hitl.md)
