---
status: ready-for-agent
---

# Spec: Route-based pipeline wiring

## Problem Statement

Wiring a Stageflow pipeline today means using three separate, disconnected mechanisms: `needs` (a stage declares its own predecessors, inbound), `fork` (a stage declares that its own runtime envelope will pick which of its children run), and `feedback_loop` (a stage declares that it may replay back to an earlier stage, with its own retry policy). These point in different directions and are authored on different stages for what is, conceptually, all the same thing — what happens after a stage finishes. A pipeline author has to hold all three vocabularies in their head at once, coordinate declarations across stages to express a single branch or loop, and there is no coherent place to hang a future "route to the next stage based on a condition" feature without adding a fourth disconnected mechanism.

## Solution

Replace `needs`, `fork`, and `feedback_loop` with a single field, `route`, declared outbound on the stage that decides where execution goes next. A stage's `route` is a list of structured entries: a forward entry hands off to another stage under an optional terminal-state gate (`on`), and a loop entry (marked explicitly, `type: loop`) sends execution back to an earlier stage with the same retry policy fields `feedback_loop` carries today. Branching falls out naturally — a stage with more than one route entry is a fork, resolved by the same envelope-reported `fork_choice` mechanism as today, constrained by a new `route_select: "one" | "subset"` + `allow_none` pair replacing today's `fork` config. Because nothing points at a stage from outside anymore, pipeline entry points must be marked explicitly (`entry: true`) instead of inferred from "has no `needs`." This is a clean, breaking rename with no dual-syntax support; the internal resolved-DAG shape the scheduler and executor consume is unchanged, so this is confined to the pipeline config parsing/validation layer.

## User Stories

1. As a pipeline author, I want to declare where a stage goes next directly on that stage, so I don't have to hunt through every other stage's config to find who points back at it.
2. As a pipeline author, I want to express a normal hand-off and a branch using the same field, so forking isn't a separate vocabulary from ordinary sequencing.
3. As a pipeline author, I want to express a retry/feedback loop using the same field as everything else, so I don't need a fourth top-level wiring key.
4. As a pipeline author, I want an explicit way to mark which stage(s) start a pipeline, so a stage I forgot to route to doesn't silently become an unintended orphan start.
5. As a pipeline author, I want a stage that must wait on multiple predecessors to just work without extra wiring, so common fan-in shapes stay simple.
6. As a pipeline author who used `fork`, I want to keep controlling how many of several possible next stages actually get taken (`one` vs `subset`) and whether none is allowed, so I don't lose existing branch-selection behavior.
7. As a pipeline author who used `feedback_loop`, I want `max_replays`, `on_max_replays`, and `replay_session` to keep meaning exactly what they mean today, so I don't have to relearn my retry policy.
8. As a pipeline author, I want route entries to always be structured objects, never bare strings, so a future condition/expression field can be added later without another breaking schema change.
9. As a pipeline author, I want a clear validation error at load time — not confusing behavior at runtime — if I reference an unknown target stage in a route entry.
10. As a developer maintaining Stageflow, I want the DAG resolution logic to stay a pure function testable via fixtures, so behavior is verifiable without running a real pipeline.
11. As a developer maintaining Stageflow, I want the internal resolved-DAG shape to stay unchanged, so the scheduler, fork-choice handling, and replay execution need no modification.
12. As a pipeline author with an existing `needs`/`fork`/`feedback_loop` pipeline, I want a hard, loud validation error if I still use the old field names, so I know to migrate instead of getting silently wrong behavior.
13. As a pipeline author, I want cycle detection to still catch runaway forward routing, so a mistake in ordinary sequencing can't accidentally author an infinite pipeline.
14. As a pipeline author, I want loop entries excluded from cycle detection (since they're deliberate, policy-governed loops, not accidental cycles), so I can express legitimate retries without tripping the cycle check.
15. As a pipeline author, I want the loop-target-must-be-an-ancestor rule preserved, so a loop entry can't point somewhere structurally nonsensical.
16. As a pipeline author, I want the existing `clonable` and `replay_safe` constraints on loop routes preserved, so this rename doesn't quietly weaken replay-safety guarantees.
17. As a pipeline author, I want `route_select`/`allow_none` to behave exactly as `fork`'s `select`/`allow_none` did, so branching pipelines only need a field rename, not a behavior change.
18. As a pipeline author, I want a validation error if `route_select` is set on a stage with fewer than two forward route entries, so config implying a decision that can never happen is caught early (mirrors today's "fork on a leaf" rejection).
19. As a pipeline author, I want a validation error if no stage in the pipeline is marked `entry: true`, so I can't accidentally author a pipeline with no starting point.
20. As a pipeline author, I want a validation error if a stage is neither marked `entry: true` nor named as a target by any route entry, so I don't unknowingly leave a dead, unreachable stage in the pipeline.
21. As a pipeline author, I want a stage's un-chosen fork branches to still count as "resolved" for any downstream join waiting on them, so an AND-join can never deadlock behind a skipped branch.
22. As a pipeline author with multiple stages routing to the same target, I want that target to run once every one of those source stages has reached any terminal state, so ordinary fan-in doesn't require extra join configuration.
23. As a pipeline author who needs a fan-in gated on specific per-parent states (the one capability this change removes from `needs`), I want that limitation to be visible and documented, so I know to restructure rather than assume it's still supported.
24. As a developer maintaining Stageflow, I want existing fixture pipelines (feedback loops, forks, fan-ins, clone/replay combinations) rewritten to `route` syntax rather than duplicated, so the same real-world pipeline shapes keep being exercised under the new schema.
25. As a pipeline author, I want the loop entry's destination field named the same way a forward entry's is (`to`, not `target`), so I'm not holding two different naming conventions for "where does this go" within one field.
26. As a pipeline author, I want terminal-state gating (`on`) on a forward route entry to be interpreted as the *source* stage's own outcome, so the semantics are unambiguous now that the field is declared outbound.

## Implementation Decisions

- Replace `PipelineNeeds`/`NeedTerminalState`/`PipelineNeedEdge`/`PipelineNeedItem`, `PipelineForkConfig`, and `FeedbackLoopConfig` with a unified route type: `PipelineRoute = PipelineRouteEntry[]`, where `PipelineRouteEntry` is a discriminated union of a forward entry (`{ to: string; on?: TerminalState | TerminalState[] }`, `on` defaulting to succeeded-only as `needs` does today) and a loop entry (`{ type: "loop"; to: string; max_replays: number; on_max_replays: "require_continue" | "wait_for_human"; replay_session: "resume" | "new_session" }`).
- New stage-level fields: `route: PipelineRoute` (replaces `needs`), `route_select?: "one" | "subset"` plus `allow_none?: boolean` (replaces `fork`), and `entry?: boolean` (new, no prior equivalent).
- `needs`, `fork`, and `feedback_loop` are removed from the stage schema entirely; their presence on any stage is a hard parse-time validation error rather than being silently ignored or accepted.
- DAG resolution inverts `route` to build the same internal forward-edge/predecessor structure the runtime already consumes: each forward route entry becomes a directed edge from the declaring stage to its `to` target, carrying the `on` gate (now evaluated against the declaring stage's own terminal state); loop entries contribute no forward DAG edge, matching today's `feedback_loop` behavior of being a runtime-only replay schedule over the already-resolved forward graph.
- Fork-equivalent validation: `route_select` requires at least two forward route entries on that stage (the inverse framing of today's "fork can't be on a leaf with no children" check). `allow_none` keeps its current meaning — when false (default), the fork-choice envelope must select at least one entry.
- Loop validation is carried over unchanged in intent: a `type: loop` entry's `to` must resolve to a declared ancestor of the source stage in the forward graph; neither the source nor the target may be `clonable`; no stage on the resulting replay route (target through source, inclusive) may have `replay_safe: false`.
- New entry-stage validation: at least one stage in the pipeline must be marked `entry: true`; a stage that is neither entry-marked nor the target of any route entry is a validation error ("unreachable stage") instead of a silently dead stage.
- Cycle detection stays conceptually the same (topo-sort over forward, non-loop edges); because loop entries never produce forward edges, they cannot trigger a false-positive cycle, exactly as today.
- Join readiness for a stage with multiple incoming forward route entries is "every source stage naming this stage as a target has reached any terminal state" — no per-edge state requirement gates join readiness itself; each edge's own `on` condition still governs whether that specific edge counts as fired (and therefore whether skip-cascade applies), unchanged from today's per-edge semantics.
- No runtime/executor/scheduler module changes — `fork_choice` envelope handling, replay execution, and skip-cascade propagation continue operating on the same internal resolved-DAG shape; only the config layer producing that shape changes.

## Testing Decisions

- A good test here asserts on the resolved DAG structure, or on the thrown validation error and its kind/message, given a fixture pipeline — never on which private helper function ran internally.
- The pipeline DAG resolution function is the only module tested directly for this spec; no execution/runtime tests are needed since the internal DAG shape and all downstream runtime code are unchanged.
- Prior art: the existing pipeline-DAG test suite already exercises this exact function against YAML fixtures for `needs`, `fork`, and `feedback_loop` shapes (linear chains, diamond fan-ins, parallel forks, clone/replay combinations, cycle detection, unknown-target rejection). Those fixtures should be rewritten to `route` syntax rather than duplicated, so the same real-world pipeline shapes stay exercised; net-new fixtures are added only for cases this change introduces (missing entry-stage, unreachable-stage, `route_select` without ≥2 forward entries, legacy-field-present rejection).
- Cases to cover: a single forward route (linear case), multi-entry route with `route_select: "one"`/`"subset"` and `allow_none` (fork cases), a `type: loop` entry for each `on_max_replays` value (feedback-loop cases), fan-in via multiple stages routing to the same target (diamond fan-in cases), cycle detection over forward-only edges, loop-target-not-an-ancestor rejection, loop `clonable` rejection, `replay_safe: false` on a replay route rejection, missing `entry: true` anywhere rejection, unreachable-stage rejection, `route_select` present with fewer than two forward entries rejection, and legacy `needs`/`fork`/`feedback_loop` field presence rejection.

## Out of Scope

- Conditional routing (arbitrary `when:`/expression-based route entries) — this spec only guarantees `route` entries are structured objects so that capability can be added later without another breaking change.
- Any deprecation shim or dual-syntax support for `needs`/`fork`/`feedback_loop` — this is a clean breaking rename.
- Rewriting the narrative docs and example pipelines that reference the old fields (the YAML catalog, README, quickstart, architecture docs, and the fork/feedback-loop example walkthroughs) — necessary follow-up, but content work outside this spec's implementation/testing scope.
- Any runtime, executor, or scheduler changes — the resolved internal DAG shape is unchanged, so this spec is confined to the config parsing/validation seam.
- Automated codemod/migration tooling for existing pipeline definitions across the codebase and its test fixtures.

## Further Notes

- Domain vocabulary for this spec — Route, Route Entry, Fork Choice, Loop, Entry Stage, Join — is recorded in the project's domain glossary.
- Design rationale and rejected alternatives (edge direction, fan-in semantics, keeping fork-choice envelope-reported rather than condition-evaluated) are recorded in a dedicated ADR and not restated here.
- Because the old fields become hard errors, any pipeline still using `needs`/`fork`/`feedback_loop` will fail to load until migrated to `route` — there is no soft-landing period.
