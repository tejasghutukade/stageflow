# generic-fan-in

Dummy catalog for **manual operator-console testing** of generic multi-parent
fan-in. `research` and `validation` run in parallel after `clarify`, pause on
a free-text gate, then emit distinct payloads. `synthesize` waits for both and
must copy `priorEnvelopesByStage` into `payload.received` so you can inspect
what was handed across the join.

Two pipelines:

| Pipeline | What it exercises |
|----------|-------------------|
| `generic-fan-in` | String `needs: [research, validation]` — both parents must succeed |
| `generic-fan-in-accepted` | Structured `on` — research may fail or skip; validation must succeed |

## Prerequisites

Use this repo's CLI (`npm run build` / `npm run dev`) or a Stageflow release
that includes generic fan-in. A globally installed `sf` from npm may lag.

- Node.js ≥ 20
- From repo root: `npm run build` and `npm run ui:build`
- Provider auth connected (`sf ui` → Settings → Providers). Stages use `cursor/auto`.

Run state lives in `<repo>/.stageflow` even if you start the console from a subdirectory.

## Terminal 1 — operator console

From the **repository git root**:

```bash
npm run build
npm run ui:build
PI_CURSOR_SETTING_SOURCES=all STAGEFLOW_ACTIVITY_VERBOSE=1 node dist/cli.js ui
```

`npm run dev -- ui` runs the TypeScript CLI via tsx; use `node dist/cli.js ui` after `ui:build` so the console is served from `dist/ui`. Do not use a globally installed `sf` — Homebrew `sf` is an older build that cannot load this catalog.

Open `http://127.0.0.1:3847`. Browse should list **generic-fan-in** and **generic-fan-in-accepted** (same names as the YAML files).

## Terminal 2 — start a run (repo root)

```bash
node dist/cli.js validate --pipeline examples/generic-fan-in/generic-fan-in.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/generic-fan-in/generic-fan-in.pipeline.yaml \
  --task examples/generic-fan-in/generic-fan-in.task.yaml
```

Exit code `2` means waiting on operator input. Leave this terminal; do the rest in the console.

Start a **new run** for each scenario below. Do not reuse a finished run.

---

## Scenario A — both parents succeed (main envelope check)

At **research**, answer exactly:

```
ok glaciers
```

At **validation**, answer exactly:

```
ok citations
```

Order of answers does not matter. `synthesize` starts only after both succeed.

### What to verify

1. Track is a diamond: `clarify` fans out to **research** and **validation**, then both wires inbound into **synthesize**.
2. While only one parent is answered, select **synthesize**. It stays blocked. Copy / `blocked_by` lists the remaining parent, not only the first YAML parent.
3. After `research` succeeds, select it and open **Files → Handoff envelope** (or `#/runs/<runId>/stages/research/envelope`). Payload should have `finding: glaciers`.
4. After `validation` succeeds, open its handoff envelope. Payload should have `finding: citations`.
5. **synthesize** runs once both parents succeeded. Open its handoff envelope. Confirm:
   - `payload.received` has keys `research` then `validation` (YAML declaration order, not the order you answered).
   - `received.research.finding` is `glaciers` and `received.validation.finding` is `citations`.
   - Summary mentions both parent keys and their success status.
6. From the repo root, you can also print the same records:

```bash
node dist/cli.js envelope get --run <runId> --stage research --json
node dist/cli.js envelope get --run <runId> --stage validation --json
node dist/cli.js envelope get --run <runId> --stage synthesize --json
```

`<runId>` is on the run detail URL (`#/runs/<runId>/…`) and in the run list.

The synthesize payload is the join copy of `priorEnvelopesByStage`. That field is keyed; it is not a clone-list `priorEnvelopes` array, and `priorEnvelope` is null on the join.

---

## Scenario B — unaccepted failure skips the join

New run of **generic-fan-in**. At research, answer:

```
fail
```

At validation, answer:

```
ok citations
```

### What to verify

1. **research** is failed (open its handoff envelope — failure status, no finding).
2. **validation** still finishes; its envelope is success with `citations`.
3. **synthesize** is **skipped** (this pipeline's `needs` array accepts success only).
4. Run outcome **failed**.
5. Open synthesize anyway: there is no join envelope. The skipped join did not receive `priorEnvelopesByStage`.

---

## Scenario C — accepted failure still joins

New run:

```bash
node dist/cli.js run \
  --pipeline examples/generic-fan-in/generic-fan-in-accepted.pipeline.yaml \
  --task examples/generic-fan-in/generic-fan-in-accepted.task.yaml
```

At research, answer `fail`. At validation, answer `ok citations`.

### What to verify

1. **research** stays visibly **failed**. **validation** succeeds.
2. **synthesize** still runs. Open its handoff envelope:
   - `received.research.status` is `failure` (no finding).
   - `received.validation.status` is `success` and `finding` is `citations`.
3. Run outcome **succeeded** — the accepted research failure does not independently fail the run.

---

## Envelope inspector (any scenario)

On a completed stage, the first Files row is **Handoff envelope**. It opens the
inspector (`#/runs/<runId>/stages/<stageId>/envelope`) with `summary`, `payload`,
and artifact paths. Use that for the parent envelopes; use **synthesize** for the
keyed join copy.

CLI equivalent: `node dist/cli.js envelope get --run <runId> --stage <stageId> --json`.
