# Route `if` tour

One pipeline that walks every **runtime** deterministic-`if` case that can succeed in a single run. Each stage does one job. Payloads are baked into prompts so the gates that we claim to cover actually fire.

This catalog is a **deep spine**. In the operator console you walk **top to bottom**: ungated `to:` continues the story. Gated `if`s are local side branches that mostly leaf. Fan-out exists only where the scenario needs it (several matching `if`s, a join with two parents, skip-cascade, or the two-way split that keeps `quiet` all-gated).

A condition that stays false does **not** count as covering that operator. Misses exist only where skip / quiet-end / join-skip **is** the scenario.

Illegal catalogs (`if` on a loop, optional field, empty `all`, …) cannot live in this file — validate would reject the whole pipeline. Those stay under [`../route-wiring-smoke-test/rejected/`](../route-wiring-smoke-test/).

## Run

From the repo git root, after `sf ui` is up, pick pipeline `route-if-tour` and task `route-if-tour`.

Or:

```bash
npx tsx src/cli.ts validate --pipeline examples/route-if-tour/route-if-tour.pipeline.yaml
npx tsx src/cli.ts run \
  --pipeline examples/route-if-tour/route-if-tour.pipeline.yaml \
  --task examples/route-if-tour/route-if-tour.task.yaml
```

Validate should succeed (`ok: true`) with warning `pipeline.route_all_gated` on `gated-only`, `quiet`, and `loop-check` (every **forward** `to:` has `if`; the loop on `loop-check` does not count as an ungated sibling). `--strict` does not promote that warning. You may also see `pipeline.model_applies` because `model` is set on the pipeline, not on each stage.

The run should **succeed**. Skipped stages: `skipped-page`, `skipped-page-child`, `skipped-quiet`, `assemble-miss`, `assemble-mix-miss`, `skipped-coerced`. Every other stage should **succeed**. `loop-check` should `send_back` once (replay `loop-draft`) then `continue` so `loop-done` runs.

Joins still wait even though their parents sit on the spine in sequence: `assemble-ok` does not start until both `write` and `draw` are terminal.

## Walk (follow-along order)

Ungated `to:` is the next spine stage. Gated `if`s are local.

| Level | Spine stage | Always continues | Local branches |
|-------|-------------|------------------|----------------|
| 1 | `kickoff` | `classify` | — |
| 2 | `classify` | `score` | `ran-eq-string`, `ran-eq-int`, `ran-eq-num`, `ran-eq-bool`, `ran-ne`, `ran-in`, `ran-not-in`, `ran-gt-num` (`if`) |
| 3 | `score` | `account` | `ran-gt`, `ran-gte`, `ran-lt`, `ran-lte` (`if`) |
| 4 | `account` | `verdict` | `ran-nested` (`if`) |
| 5 | `verdict` | `compose` | `ran-ref` (`if`) |
| 6 | `compose` | `triage` | `ran-all`, `ran-any`, `ran-not`, `ran-nested-compose`, `ran-any-of-alls` (`if`) |
| 7 | `triage` | `ran-notify` | `skipped-page` (`if` miss: `severity eq high`, emit `low`) |
| 8 | `skipped-page` | — | `skipped-page-child` (skip-cascade) |
| 9 | `ran-notify` | `gated-only` | — |
| 10 | `gated-only` | — (all-gated fire) | `ran-all-gated` only (`if go eq true`; emit `go true`) |
| 11 | `ran-all-gated` | `quiet` **and** `write` (two ungated) | required 2-way fan-out so `quiet` can stay all-gated |
| 12 | `quiet` | — (dead-end all-gated miss) | `skipped-quiet` only (`if go eq true`; emit `go false`) |
| 13 | `write` | `draw` | `assemble-ok` (`if ready eq true`; emit `true`) |
| 14 | `draw` | `write-miss` | `assemble-ok` (`if complete eq true`; emit `true`) |
| 15 | `write-miss` | `draw-miss` | `assemble-miss` (`if ready eq true`; emit `true`) |
| 16 | `draw-miss` | `mix-open` | `assemble-miss` (`if complete eq true`; emit `false` so MISS) |
| 17 | `mix-open` | `mix-gated` | `assemble-mix-ok` (no `if`) |
| 18 | `mix-gated` | `mix-open-miss` | `assemble-mix-ok` (`if ready eq true`; emit `true`) |
| 19 | `mix-open-miss` | `mix-gated-miss` | `assemble-mix-miss` (no `if`) |
| 20 | `mix-gated-miss` | `strict-num` | `assemble-mix-miss` (`if ready eq true`; emit `false` so MISS) |
| 21 | `strict-num` | `loop-draft` | `ran-int-one` (`if n eq 1`); `skipped-coerced` (`if n eq "1"` string). Emit `{"n":1}` integer |
| 22 | `loop-draft` | `loop-check` | — |
| 23 | `loop-check` | — | `loop-done` (`if pass eq true`); `{ type: loop }` to `loop-draft` (`max_replays: 1`, `on_max_replays: require_continue`, `replay_session: resume`). First attempt `send_back`, second `continue`. Payload `{"pass":true}`. `loop-done` has `replay_safe: false` |

## Lanes

Each scenario is a stop on the spine (plus its local `if` leaves), not a parallel lane from `kickoff`.

| Stop | Source payload | What you should see |
|------|----------------|---------------------|
| Classify | `kind=ok`, `count=3`, `ratio=1.5`, `flag=true`, `tag=gold` | Eight gated handlers run; spine continues to `score` |
| Score | `score=10` | `gt` / `gte` / `lt` / `lte` all fire; spine continues to `account` |
| Account | `customer.tier=gold` | Nested path fires; sequential `io` on `ran-nested` |
| Verdict | `ok=true` via `$ref` `#/schemas/flag` | `$ref` path check fires |
| Compose | `severity=high`, `channel=web`, `customer.tier=gold` | `all`, `any`, `not`, nested `not(all)`, `any` of `all`s all fire |
| Triage | `severity=low` | `skipped-page` skips; skip-cascade skips `skipped-page-child`; `ran-notify` still runs |
| All-gated fire | `go=true` | Validate warns; `ran-all-gated` still runs |
| Quiet miss | `go=false` | `skipped-quiet` skips; the run still succeeds |
| Join fire | write `ready=true`, draw `complete=true` | `assemble-ok` runs with both envelopes after both parents are terminal |
| Join miss | write-miss `ready=true`, draw-miss `complete=false` | `assemble-miss` skips (not pending, not partial) |
| Mixed join fire | `mix-open` ungated, `mix-gated` `ready=true` | `assemble-mix-ok` runs |
| Mixed join miss | `mix-open-miss` ungated, `mix-gated-miss` `ready=false` | `assemble-mix-miss` skips |
| Type-strict | integer `n=1` | `ran-int-one` runs (`eq 1`); `skipped-coerced` skips (`eq "1"`) |
| Loop | `pass=true`; first attempt `send_back`, second `continue` | `loop-draft` replays once; `loop-done` runs after continue; `if` on the forward, not on the loop |

## Scenario table

| Scenario | How this pipeline covers it | Evidence |
|----------|------------------------------|----------|
| `if` on a forward Route Entry | Every gated `to:` below | Child runs or (for skip rows) is skipped |
| Evaluated only against the source payload | Prompts emit payload only; no status/timestamp fields in `if` | Gates match those JSON fields |
| No `if` → edge always fires | Spine `to:` with no `if` (`kickoff` → `classify`, `classify` → `score`, …, `ran-notify` → `gated-only`, `ran-all-gated` → `quiet` and `write`) | Those stages succeed |
| Mix always-run + gated siblings | `triage` → `skipped-page` (`if`) + `ran-notify` (no `if`) | `ran-notify` succeeds while `skipped-page` skips |
| Two (or more) matching `if`s both fire | `classify` and `score` each have several true `if`s | All `ran-eq-*` / `ran-gt` / `ran-gte` / `ran-lt` / `ran-lte` succeed |
| `eq` string | `kind eq ok` | `ran-eq-string` succeeded |
| `eq` integer | `count eq 3` | `ran-eq-int` succeeded |
| `eq` number | `ratio eq 1.5` | `ran-eq-num` succeeded |
| `eq` boolean | `flag eq true` | `ran-eq-bool` succeeded |
| `ne` | `kind ne fail` | `ran-ne` succeeded |
| `gt` integer | `score gt 5` (10 > 5) | `ran-gt` succeeded |
| `gt` number | `ratio gt 1.0` | `ran-gt-num` succeeded |
| `gte` (equal bound) | `score gte 10` | `ran-gte` succeeded |
| `lt` | `score lt 20` | `ran-lt` succeeded |
| `lte` (equal bound) | `score lte 10` | `ran-lte` succeeded |
| `in` | `tag in [gold, silver]` | `ran-in` succeeded |
| `not_in` | `tag not_in [bronze]` | `ran-not-in` succeeded |
| Nested object path | `customer.tier eq gold` | `ran-nested` succeeded |
| `$ref` / `schemas:` after expansion | `verdict` output `$ref: "#/schemas/flag"`, `ok eq true` | `ran-ref` succeeded |
| Sequential `io` still applies on a fired gated edge | `ran-nested` / `ran-ref` / `ran-all` require a subset of the parent output | Those stages start with that input |
| `all` (AND) true | both leaves true | `ran-all` succeeded |
| `any` (OR) true | `channel eq web` true; the `severity eq low` arm is **not** a covered `eq` | `ran-any` succeeded |
| `not` true | `not (severity eq low)` | `ran-not` succeeded |
| Nested `not` around `all` | `not (severity low AND channel phone)` | `ran-nested-compose` succeeded |
| Nested `any` of `all`s | first `all` true (high+web); second `all` is not a covered `all` | `ran-any-of-alls` succeeded |
| Independent evaluation (not first-match) | compose's five `if`s all true | five compose handlers succeed |
| Single-parent miss → skip, run still succeeds | `triage` `severity eq high` is **false** on purpose | `skipped-page` skipped; run succeeded |
| Skip-cascade | `skipped-page` routes to `skipped-page-child` with no `if` | `skipped-page-child` skipped too |
| Always-run sibling still runs after a miss | `ran-notify` | succeeded |
| Nothing matches and nothing else pending | `quiet` only forward `if` misses | `skipped-quiet` skipped; run succeeded |
| `pipeline.route_all_gated` warning | `gated-only`, `quiet`, and `loop-check` have only gated **forwards** | validate warning, `ok: true` |
| All-gated `if` that **does** match | `gated-only` `go eq true` | `ran-all-gated` succeeded |
| Loop does not count as an ungated sibling | `loop-check` has gated `to: loop-done` plus `{ type: loop }` | `pipeline.route_all_gated` on `loop-check` |
| Join waits for every parent | `write` and `draw` both route to `assemble-ok` (parents run in sequence on the spine) | `assemble-ok` does not start until both succeeded |
| Join runs only when every inbound `if` fired | both `ready` and `complete` true | `assemble-ok` succeeded |
| Each parent's `if` reads that parent only | `write.ready` vs `draw.complete` | `assemble-ok` sees both envelopes |
| Join skip when any inbound `if` missed | `draw-miss` emits `complete: false` | `assemble-miss` skipped |
| Missed join `if` does not skip while the other parent runs | `write-miss` fires; `draw-miss` misses | child waits, then skips |
| Mixed join (ungated + gated fire) | `mix-open` has no `if`; `mix-gated` `ready eq true` | `assemble-mix-ok` succeeded |
| Mixed join (ungated + gated miss) | `mix-open-miss` ungated; `mix-gated-miss` `ready eq true` misses | `assemble-mix-miss` skipped |
| DAG still lists skipped `to:` | skipped stages still appear on the map | visible as skipped, not missing |
| Type-strict comparison | `strict-num` emits integer `1` | `ran-int-one` succeeded; `skipped-coerced` skipped (`eq "1"` did not coerce) |
| Loop still works next to `if` | `loop-check` has `{ type: loop }` to `loop-draft` and a gated forward `to: loop-done` | DAG shows the loop; `loop-done` succeeded after continue |
| `send_back` then `continue` | first `loop-check` attempt sends back; second continues | `loop-draft` runs twice; then `loop-done` |
| `if` stays off the loop entry | `if` is only on the forward to `loop-done` | validate still `ok` |

## Expected stage status

| Stage | Status | Why |
|-------|--------|-----|
| `kickoff` | succeeded | entry |
| `classify` | succeeded | ungated from kickoff |
| `ran-eq-string` | succeeded | `if` met |
| `ran-eq-int` | succeeded | `if` met |
| `ran-eq-num` | succeeded | `if` met |
| `ran-eq-bool` | succeeded | `if` met |
| `ran-ne` | succeeded | `if` met |
| `ran-in` | succeeded | `if` met |
| `ran-not-in` | succeeded | `if` met |
| `ran-gt-num` | succeeded | `if` met |
| `score` | succeeded | ungated from classify |
| `ran-gt` | succeeded | `if` met |
| `ran-gte` | succeeded | `if` met |
| `ran-lt` | succeeded | `if` met |
| `ran-lte` | succeeded | `if` met |
| `account` | succeeded | ungated from score |
| `ran-nested` | succeeded | `if` met |
| `verdict` | succeeded | ungated from account |
| `ran-ref` | succeeded | `if` met |
| `compose` | succeeded | ungated from verdict |
| `ran-all` | succeeded | `if` met |
| `ran-any` | succeeded | `if` met |
| `ran-not` | succeeded | `if` met |
| `ran-nested-compose` | succeeded | `if` met |
| `ran-any-of-alls` | succeeded | `if` met |
| `triage` | succeeded | ungated from compose |
| `skipped-page` | **skipped** | `severity` is `low`, not `high` |
| `skipped-page-child` | **skipped** | skip-cascade from `skipped-page` |
| `ran-notify` | succeeded | ungated from triage |
| `gated-only` | succeeded | ungated from ran-notify |
| `ran-all-gated` | succeeded | `if` met |
| `quiet` | succeeded | ungated from ran-all-gated |
| `skipped-quiet` | **skipped** | `go` is `false` |
| `write` | succeeded | ungated from ran-all-gated |
| `draw` | succeeded | ungated from write |
| `assemble-ok` | succeeded | both inbound `if`s met (write then draw, then join) |
| `write-miss` | succeeded | ungated from draw |
| `draw-miss` | succeeded | ungated from write-miss |
| `assemble-miss` | **skipped** | `draw-miss` inbound `if` missed |
| `mix-open` | succeeded | ungated from draw-miss |
| `mix-gated` | succeeded | ungated from mix-open |
| `assemble-mix-ok` | succeeded | ungated inbound fired and gated inbound matched |
| `mix-open-miss` | succeeded | ungated from mix-gated |
| `mix-gated-miss` | succeeded | ungated from mix-open-miss |
| `assemble-mix-miss` | **skipped** | gated inbound missed |
| `strict-num` | succeeded | ungated from mix-gated-miss |
| `ran-int-one` | succeeded | integer `1 eq 1` |
| `skipped-coerced` | **skipped** | integer `1` is not string `"1"` |
| `loop-draft` | succeeded | ungated from strict-num; replayed once after `send_back` |
| `loop-check` | succeeded | `send_back` then `continue`; forward `if` met on continue |
| `loop-done` | succeeded | gated forward from `loop-check` after continue |

## Not in this pipeline

These are real cases, but putting them here would either fail validate or fail the run, so they are **not** claimed as covered by this example.

| Scenario | Why it is absent | Where to see it |
|---------|------------------|-----------------|
| `if` field not in schema | `pipeline.route_if_invalid` | `examples/route-wiring-smoke-test/rejected/22-reject-if-unknown-field.pipeline.yaml` |
| `if` field optional / not `required` | same | `rejected/23-reject-if-optional-field.pipeline.yaml` |
| Empty `all` / `any` / `in` | same | `rejected/24-reject-if-empty-all.pipeline.yaml` |
| `gt` on a string | same | `rejected/25-reject-if-gt-on-string.pipeline.yaml` |
| Nested optional path | same | `rejected/26-reject-if-optional-nested.pipeline.yaml` |
| `if` on `{ type: loop }` | same | `rejected/27-reject-if-on-loop.pipeline.yaml` |
| `if` + `on: [failed]` | same | `rejected/29-reject-if-on-failed.pipeline.yaml` |
| Failed parent blocks a Join | a failed parent fails/blocks the run | runtime tests / yaml-catalog Generic fan-in |
| Payload-gated loops (`if` on `{ type: loop }`) | out of scope; would fail validate | `rejected/27-reject-if-on-loop.pipeline.yaml` |
| `exists` / array paths / fallback / first-match-wins | out of scope | spec |
