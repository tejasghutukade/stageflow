# conditional-fork

Operator HITL, then exclusive Route `if`. The `decide` stage asks for **branch-a** or **branch-b**, emits that value on `payload.branch`, and listed successors stay on the DAG. After success, each `if` runs against that payload: the matching arm runs; the other is skipped. The completing agent does not pick YAML successors.

See [YAML catalog — Route wiring](../../docs/yaml-catalog.md#route) (Route `if`). `if.field` must be a required output property — optional fields cannot be used in `if`.

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

`decide` is `entry: true` with two `route` targets, each gated by `if` (`field: branch`, `op: eq`). After the operator answers, the agent emits `payload: { "branch": "branch-a" }` or `{ "branch": "branch-b" }`. Stageflow evaluates those predicates against the success payload: the matching successor runs; the miss is skipped. Both `to:` stay on the DAG.

`io.output.schema` requires `branch` as a string so `if.field: branch` is valid. Branch stage `io.input` is an empty object (a subset of decide output).

Validate may warn `pipeline.route_all_gated` because every forward `to:` on `decide` has `if`. That warning keeps `ok: true`; `--strict` does not promote it.

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

- [YAML catalog — Route wiring](../../docs/yaml-catalog.md#route)
- [YAML catalog — Upgrading older catalogs](../../docs/yaml-catalog.md#upgrading-older-catalogs)
- [HITL](../../docs/hitl.md)
- Fixtures: [`route-if-eq.pipeline.yaml`](../../tests/fixtures/pipelines/route-if-eq.pipeline.yaml)
- Related walkthrough: [`../route-if-tour/`](../route-if-tour/)
