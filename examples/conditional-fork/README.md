# conditional-fork

Exclusive fork: the operator picks **branch-a** or **branch-b** at a HITL gate;
`decide` emits `fork_choice`, and the unchosen branch is `skipped`.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`), **or** this repo built (`npm run build`)
- Provider auth connected (`sf ui` → Settings → Providers, or `sf providers login …`)
- Operator console for the gate: `sf ui` (default `http://127.0.0.1:3847`)

## Manual test

Commands run from the **repository git root**. Run state lives in `<repo>/.stageflow` even if you start `sf ui` from a subdirectory.

### Terminal 1 — operator console

```bash
cd examples/conditional-fork
sf ui
```

### Terminal 2 — validate and run (repo root)

```bash
sf validate --pipeline examples/conditional-fork/fork-demo.pipeline.yaml --strict
sf run \
  --pipeline examples/conditional-fork/fork-demo.pipeline.yaml \
  --task examples/conditional-fork/fork-demo.task.yaml
```

### From the Stageflow repo (no global install)

```bash
npm run build
npm run dev -- validate --pipeline examples/conditional-fork/fork-demo.pipeline.yaml --strict
npm run dev -- run \
  --pipeline examples/conditional-fork/fork-demo.pipeline.yaml \
  --task examples/conditional-fork/fork-demo.task.yaml
```

### At the HITL gate

When `decide` blocks, open the run in the console and answer the free-text prompt with exactly:

- `branch-a`, or
- `branch-b`

Exit code `2` means waiting on operator input. See [docs/hitl.md](../../docs/hitl.md).

### What to verify in the UI

After you answer:

1. The chosen branch stage (`branch-a` or `branch-b`) reaches **succeeded**
2. The other branch is **skipped**
3. The run overall **succeeded**

### Re-test the other branch

Start a **new** run and answer the opposite id at the gate.

## How it works

`decide` has `fork: { select: one }` and two children with `needs: decide`. After the operator answers, the agent emits `fork_choice: ["branch-a"]` or `["branch-b"]`. Stageflow runs only the named successor and marks the other `skipped`.

## Layout

```
examples/conditional-fork/
  fork-demo.pipeline.yaml
  fork-demo.task.yaml
  decide.yaml
  branch-a.yaml
  branch-b.yaml
```

## References

- [YAML catalog — Fork pipelines](../../docs/yaml-catalog.md#fork-pipelines)
- [Envelopes — Fork stages](../../docs/envelopes.md#fork-stages)
- Fixtures: [`fork-one-of-two.pipeline.yaml`](../../tests/fixtures/pipelines/fork-one-of-two.pipeline.yaml), [`fork-route-cascade.pipeline.yaml`](../../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml)
