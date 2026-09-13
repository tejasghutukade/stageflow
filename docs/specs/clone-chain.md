---
status: ready-for-agent
---

# Spec: Clone Chain

## Problem Statement

Splitting one stage's work into several runs of the next stage today means a second wiring language: the child opts in with `clonable`, and the parent agent emits `clone_forks` (`skip` / `once` / `fanout`, a clones list, and parallel vs sequential). N is whatever the agent listed, not the list in its output, and a single item is a special `once` path that is not an instance. Authors who want "one run per item in this array" have to keep the data and the clone list in sync by hand, and can fan out a sibling by accident.

## Solution

A Clone Chain is a sealed inbound path: emitter → clone child → Join. The emitter's output has exactly one Clone Array — a field whose items are a named `$ref`. The clone child's entire input is that same `$ref`. After the emitter succeeds, Stageflow mints one Clone Instance per array element (`1..cap`, including `~1` when N is 1). Each instance receives that element and nothing else. Clone Cap and Clone Mode are catalog policy on the emitter's pipeline entry. There is no `clone_forks` on the envelope. The Join waits only on those instances, as ordinary Join parents; its outbound Route is a normal stage Route.

## User Stories

1. As a pipeline author, I want one run of the next stage per item in an output array, so I do not hand-write a clone list that can drift from the data.
2. As a pipeline author, I want that split to be a sealed chain (emitter → clone child → Join), so a sibling stage cannot start cloning just because it shares a type name.
3. As a pipeline author, I want the clone child's input to be a named `$ref` and the array items to be that same `$ref`, so only an explicit shared type fans out — not a lookalike inline object.
4. As a pipeline author, I want the Clone Array to be exactly one field on the emitter's output object, so two lists of the same type cannot silently pick an N.
5. As a pipeline author, I want sibling fields next to that array (a summary, metadata), so the emitter can still emit context the Join never needs to see on the clone child.
6. As a pipeline author, I want each Clone Instance to receive only the array element, so implement-style stages take `Issue`, not the whole triage payload.
7. As a pipeline author, I want a Clone Cap on the emitter's pipeline entry, so this pipeline can bound list length without editing the reusable stage file.
8. As a pipeline author, I want Clone Mode (`parallel` | `sequential`) on that same entry, so scheduling policy can differ when I reuse the emitter stage in another pipeline.
9. As a pipeline author, I want both cap and mode to be required on a Clone Chain emitter, so a chain cannot load with unbounded N or an implicit schedule.
10. As a pipeline author, I want `clone_cap` / `clone_mode` rejected on a stage that is not a Clone Chain emitter, so policy fields cannot be left on a normal stage by mistake.
11. As a pipeline author, I want an empty Clone Array to be an unsuccessful emit, so "no items" is not a hidden skip of the Join and everything after it.
12. As a pipeline author, I want a zero-item path gated before the emitter (ordinary `if` / routing on an earlier stage), so skipping the whole chain is still possible without an empty array.
13. As a pipeline author, I want length greater than the Clone Cap to be an unsuccessful emit, so the cap is hard — not a truncation and not an operator prompt.
14. As a pipeline author, I want N=1 to still be a Clone Instance (`~1`), so Join, retry, and the operator console never special-case a singleton.
15. As a pipeline author, I want the emitter's only next stage to be the clone child, so I cannot also route a sidecar off the split.
16. As a pipeline author, I want the clone child's only next stage to be the Join, so copies always meet in one place.
17. As a pipeline author, I want no `if` on those two inbound edges, so skip/filter is not a second cloning language.
18. As a pipeline author, I want the Join to wait only on the Clone Instances, so an unrelated stage cannot sit on that same Join.
19. As a pipeline author, I want the Join's outbound Route to behave like any other stage, so after gather I can continue, branch, or Loop.
20. As a pipeline author, I want a Loop from the Join only to a stage before the emitter, so replay restarts the work that produced the list — not the emitter or a Clone Instance.
21. As a pipeline author, I want the emitter, clone child, and Join to refuse being Loop targets, so replay cannot land on a partial chain.
22. As a pipeline author, I want a Clone Instance to be forbidden from emitting a Clone Array, so nested cloning is a catalog error, not a bushy Join tree.
23. As a pipeline author, I want a clone child with two parents to be a catalog error, so there is never a question of whose array is N.
24. As a pipeline author, I want two clone children from one emitter to be a catalog error, so "both take Issue, both clone" cannot happen.
25. As a pipeline author, I want several disjoint Clone Chains in one pipeline, so two unrelated splits do not have to live in two pipeline files.
26. As a pipeline author, I want a Join to be allowed to become the emitter of a following Clone Chain, so I can split, gather, then split again without nested instances.
27. As a pipeline author, I want two Clone Chains to be forbidden from sharing an emitter, clone child, or Join, so sealed inbound stays true.
28. As a pipeline author, I want inline (anonymous) array items to never form a Clone Chain, so structural similarity is not a trigger.
29. As a pipeline author, I want a missing named `$ref` match on what looks like a chain to fail at catalog load, so I am not surprised at runtime.
30. As a pipeline author, I want `clonable`, child `clone_cap`, `clone_actions`, and envelope `clone_forks` to fail loudly, so the old wiring language cannot be mixed in.
31. As a pipeline author, I want `once` / `skip` / `fanout` action tokens gone, so N is only the array length.
32. As an operator, I want parallel Clone Instances to keep running after one fails, so independent items are not cancelled mid-flight.
33. As an operator, I want sequential Clone Instances to run in array order and to skip not-yet-started instances after a failure, so a broken item does not keep spending later items.
34. As an operator, I want a failed or skipped instance to block the Join (a hole, not a partial gather), so join-doc never runs on an incomplete set.
35. As an operator, I want to retry one failed Clone Instance like any failed stage, so I do not have to re-run triage to fix a single item.
36. As an operator, I want a successful sequential retry to then start the next skipped instance, so fail-fast does not permanently kill the tail of the list.
37. As an operator, I want Clone Instances labelled distinctly in the operator console, so I can tell item 2 from item 3.
38. As an operator, I want a Clone Instance to be able to pause for HITL like any other stage, so human gates still work per item.
39. As a clone-child agent, I want my opening input to be the element JSON, so I do not have to unpack a wrapper or an index.
40. As an emitter agent, I want to succeed by emitting a valid payload only — no `clone_forks` field — so I cannot disagree with my own array.
41. As a Join agent, I want every Clone Instance's success envelope, in Clone Array order, so gather sees the same sequence the emitter produced.
42. As a CI user, I want `sf validate` to reject an illegal Clone Chain at load time, so a bad sealed shape never reaches a run.
43. As a CI user, I want an over-cap or empty emit to fail the emitter stage, so JSON/`sf run` reports that stage unsuccessful rather than minting a truncated cohort.
44. As a developer maintaining Stageflow, I want catalog rules asserted through pipeline load, so illegal YAML is a fixture error rather than a scheduler unit test.
45. As a developer maintaining Stageflow, I want minting, Join, mode, and retry asserted through a real DAG run, so tests follow the same path as `sf run`.
46. As a developer maintaining Stageflow, I want the old clonable test suite, fixtures, and example deleted — not adapted — so Clone Chain coverage is written against this spec only.
47. As a pipeline author using pipeline `schemas:`, I want the named `$ref` to resolve there, so Issue lives in one map for both sides of the chain.
48. As a pipeline author, I want `clone_cap: 1` to be legal, so a chain that must emit exactly one item is still a chain (and still `~1`).
49. As a pipeline author, I want the clone child to be unable to `send_back`, so its only success path is the Join.
50. As a pipeline author, I want a Clone Chain emitter that is also `entry: true` to work, so the split can start the pipeline.

## Implementation Decisions

- Detect a Clone Chain at catalog load from cardinality plus sealed shape, not from a `clonable: true` flag on the child. Detection: the emitter's `io.output` is an object with exactly one property whose schema is `type: array` / `items: { $ref: <id> }`; the unique forward Route target's entire `io.input` is `{ $ref: <id> }` with the same `<id>` string; that target has exactly one forward Route to a third stage (the Join); the emitter has exactly one forward Route and it is that clone child; neither inbound edge has `if`; no other stage routes to the Join; the clone child's output is not itself a Clone Array.
- Named `$ref` only. Inline item schemas never detect a chain. Two properties that are both arrays of named `$ref` are a catalog error. A root-level array (payload is a JSON array) is not a Clone Array.
- Pipeline-entry fields on the emitter: `clone_cap` (integer ≥ 1) and `clone_mode` (`parallel` | `sequential`). Both required when a Clone Chain is detected. Either field on a non-emitter is a catalog error. They are not valid on the reusable stage body.
- Compile `clone_cap` onto the Clone Array as `minItems: 1` and `maxItems: <cap>` for ordinary payload validation. An empty or over-cap emit is an unsuccessful emitter stage, not a truncated cohort and not HITL.
- On emitter success, N is the Clone Array length. Mint Clone Instances `{cloneChildId}~{n}` with 1-based `n` in array order, including N=1. Do not keep a catalog-id run for the singleton.
- Each instance's assignment payload is the element at index `n-1`, validated against the clone child's `io.input` (the `$ref`). Do not merge emitter sibling fields. Do not wrap with index metadata.
- Clone Instances are first-class Join parents. Join readiness is ordinary Join: every instance terminal, run only if every instance succeeded. The Join agent is given those success envelopes in Clone Array order. There is no clone-list join and no `clone_forks` on any envelope.
- Clone Mode is catalog-only. Parallel: remaining instances may finish after one fails. Sequential: array order; first failure skips instances that have not started. In both modes the Join does not run. Retry of a failed instance is ordinary stage retry; a successful sequential retry then starts the next skipped instance.
- Loops: the Join may declare a Loop whose `to` is a forward-graph ancestor of the *emitter*, not the emitter, not the clone child, and not the Join. Emitter, clone child, and Join are not Loop targets. The clone child cannot declare a Loop (its only Route is the Join) and cannot `send_back`.
- Multiple Clone Chains in one pipeline are allowed if they share no emitter, clone child, or Join. A Join may be the emitter of a following chain (chain-after-chain). Nested cloning (a Clone Instance emitting a Clone Array consumed as a singular `$ref`) is a catalog error.
- Remove `clonable`, child `clone_cap`, `clone_actions`, `CloneForkItem` / `clone_forks` parse-and-assert, skip/once/fanout, and emit-time mode. Presence of those YAML or envelope fields is a hard error. No dual-syntax support in a released catalog.
- A Loop must not name a Clone Chain emitter, clone child, or Join as `to`, and must not originate on the emitter or clone child.
- Clone Instances appear as distinct stage runs in the operator console. No separate clone-track product.
- Validation error kind for illegal shape/policy: one catalog kind (message names the role: emitter, clone child, Join, cap, mode, `$ref`). Legacy-field errors name the old field and point at Clone Chain.

## Testing Decisions

- A good test asserts external behavior: whether a pipeline loads, whether the emitter emit succeeds, which Clone Instances ran, what each received, whether the Join ran, and terminal states. It does not assert on private helpers, and it does not extend or restyle the old clonable / `clone_forks` tests.
- New Clone Chain fixtures only. Do not treat existing clone\* / clonable\* YAML or clone-fanout tests as templates, prior art, or fixtures to rewrite in place.
- Three seams, the same ones any pipeline feature uses — not the old clone-specific functions:
  1. Catalog load — legal Clone Chain YAML loads; every sealed-shape, `$ref`, cap/mode, Loop, and nested violation fails load with a clear error; `clone_cap: 1` loads; `clonable` / child `clone_cap` / `clone_actions` fail load.
  2. Stage success envelope / payload — emitter payload with 1..cap elements is success; empty and over-cap fail the emitter; each element matches the `$ref`; `clone_forks` on an envelope fails; after a valid emit, assignment to instance `~k` is element `k-1`.
  3. Pipeline run (and ordinary stage retry) — N instances; Join runs only when all succeed; parallel siblings may finish after a failure and Join does not; sequential fail-fast then retry continues the tail; Join outbound routes; chain-after-chain; two disjoint chains; Loop from Join to a stage before the emitter.
- Deleting the old clonable suite is ticket 06 cleanup, not a source of cases for tickets 01–05.
- CLI `sf validate` is not a required extra seam; catalog load covers it.

## Out of Scope

- Per-element `if` / filter-over-the-array (N = count of matching items).
- Nested Clone Chains (a Clone Instance as emitter).
- Dual-syntax support or a deprecation window for `clonable` / `clone_forks`.
- Operator-console chrome beyond showing Clone Instances as distinct stage runs.
- Automated codemod for customer pipelines outside this repo.
- Changing generic Join for non-clone multi-parent graphs, except that a Clone Chain Join's parents are the instances.

## Further Notes

- Glossary: Clone Chain, Clone Array, Clone Instance, Clone Cap, Clone Mode, Join, Route, Loop, Entry Stage — `CONTEXT.md`. Do not reintroduce clonable successor, clone-list join, or `clone_forks` as product terms.
- Why this shape (sealed chain, payload is N, instances are Join parents): `docs/adr/0002-clone-chain.md`.
- Tickets under `.scratch/clone-chain/issues/` are vertical slices. Ticket 01 removes old clone; 02 is the smallest working Clone Chain; 03–08 are blocked only by 02. Do not ship a catalog that still honors `clone_forks`.
