# Evals: sort failed results automatically (Jev) — plan

Status: **approved 2026-10-23** (owner asked for a "system one Jev" model to sort failures instead of tagging by hand). Builds on [evals.md](evals.md) (release 1) and [evals-agents.md](evals-agents.md). Local planning doc.

## 1. Goal

After a run, an author presses **Sort failures** and every failed or errored result gets a **suggested bucket** and **suggested failure type** with a confidence, produced by a small fast "decision model" (TypeSafe **Jev**, "System One"), without anyone reading 19 transcripts. The author reviews suggestions in the case drawer and the Failure types card, accepts them (one click, or in bulk above a confidence), and the accepted ones become the normal failure-type tags (P10, `eval_result_tags`). Nothing is ever tagged without the author's accept.

The buckets are the lesson from the Taskboard run:

| Bucket | Meaning | What the author does |
|---|---|---|
| `agent_wrong` | A careful human would say the target did something wrong | Change the agent or stage |
| `grader_wrong` | The output was fine, a grader failed it by mistake (false alarm, too literal, judge noise) | Fix the grader |
| `case_wrong` | The scenario or its expected values are wrong or ambiguous | Fix the dataset |
| `unclear` | Not enough signal | Read it |

## 2. Jev facts (from TypeSafe docs, fetched 2026-10-23; the wire contract below follows them)

- `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`. Env name in vendor docs: `TYPESAFE_API_KEY`. Access may be waitlisted. Models: `jev-latest` (alias, moves), `jev-1.13.0`, `jev-1.14.0`, `jev-preview`. **Pin a versioned id** and record it in results (response carries the answering model id).
- Body: `{ model, state, questions: { <name>: { type, instructions, criteria? } } }`. `state` is text (string, object or array; text only). Question types: `noul` (yes/no; answer `noul` = probability 0..1), `choice` (`criteria` map name -> description, 1-255; answer `choice`, `confidence`, `probabilities`), `score` (ordered `criteria` array, 1-10; answer `score`, `confidence`, `probabilities`). Response: `{ model, answers: { <name>: {...} }, usage: { input_tokens, output_tokens } }`. Questions run in parallel and in isolation on the same state.
- It never writes explanations and **always picks an answer**: include an explicit `unclear` choice. Probabilities/confidence are the escalation signal. 429 = rate limit (retry with backoff); 422 = validation.
- Context 64k tokens per request. Price about $0.042 per million input tokens; output free. Latency about 0.4 s per call. English is best supported.
- Sources: https://docs.typesafe.ai/introduction/quickstart.md, https://docs.typesafe.ai/api.md, https://docs.typesafe.ai/models.md, https://docs.typesafe.ai/concepts/system-one.md, https://langfuse.com/docs/evaluation/evaluation-methods/jev-as-a-judge, https://arize.com/blog/typesafe-jev-llm-judge/, https://mlflow.org/blog/jev-llm-judge. Vendor-authored claims are not independently replicated; the feature therefore ships as **suggestions the author confirms**, and the judge-model fallback exists so the sorter works without a Jev key.

## 3. Decisions

| # | Decision |
|---|---|
| S1 | A **`FailureClassifier` interface** in `src/evals/triage/` with two backends: `jev` (HTTP to System One) and `judge` (the existing judge-model path with a fixed prompt and JSON reply). Nothing in the engine (`src/evals/engine/promptfoo/`) is touched. Backends are chosen by `classifier` in the request (`auto` = `jev` when a TypeSafe key exists, else `judge` when a judge model is configured, else a 422 saying what to add). |
| S2 | **Suggestions, not tags.** New table `eval_result_suggestions` (migration 017): `eval_run_id`, `case_id`, `repeat_index`, `source` (`jev`/`judge`), `bucket`, `failure_type` (nullable), `confidence` (0..1), `probabilities_json`, `model`, `prompt_version`, `created_at`, `status` (`pending`/`accepted`/`dismissed`). Unique on (run, case, repeat, source). Accepting writes the failure-type tag through the existing review/tags write path (tag text = failure type; bucket stored as a tag too, prefixed `bucket:`), then marks the suggestion `accepted`. Re-sorting replaces pending suggestions and keeps accepted/dismissed ones. |
| S3 | **Questions sent to Jev** (all from one bounded `state`; no free text out): `bucket` (choice: agent_wrong, grader_wrong, case_wrong, unclear, each with a one-sentence criteria), `failure_type` (choice, generic for agent evals: `missing_tool_call`, `unneeded_tool_call`, `wrong_or_missing_fact`, `policy_violation`, `tone`, `ungrounded_claim`, `off_topic`, `no_handoff`, `other`; for stage evals: `wrong_value`, `missing_field`, `schema_invalid`, `policy_violation`, `ungrounded_claim`, `tone`, `other`), and one `noul` per failing grader that is a *code* or *rubric* grader: "Is this grader's failure a false alarm?" (answer feeds `grader_wrong`). The failure types are constants in code (`FAILURE_TYPES_BY_KIND`), never user YAML in this release. |
| S4 | **`state`** is a bounded JSON object: target kind; case `title`, `tags`, `input` (scenario or stage input), `expected`; the output (conversation subject: messages capped, tool calls with names, args summary, policy outcome; or envelope summary and payload); each failed grader `{id, type, reason, weight, must_pass}` with the grader's own definition (rubric text or code, capped) and the passing graders' ids. Reuse `renderTranscript` and the subject caps (A08). Redacted text only (`redactSecrets`, already stored redacted). Cap 24k characters so it fits the 64k-token limit with margin; truncation recorded. |
| S5 | **Cascade:** a suggestion with `bucket` confidence below `0.7` or `unclear` is shown as "Low confidence" and is not eligible for bulk accept. (Optional second backend run on those is a follow-up; not in this release.) |
| S6 | **Credentials:** the TypeSafe key is a normal provider credential (provider id `typesafe`; Pi already lists it) read through `src/agent/providerAuth.ts`, never logged, never in a response, error or result. Without one: the API returns `EVAL_CLASSIFIER_UNAVAILABLE` (422) with the missing piece; the console button explains how to add it (Settings, Providers, TypeSafe, or `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`). |
| S7 | **Cost and privacy:** Jev spend is tracked separately as `triage_cost_usd` on the suggestions batch (not part of the eval run cost cap) and shown in the UI. Docs add: sorting sends each failed result's case, output and grader reasons to TypeSafe (Jev) or to the judge model's provider. TypeSafe states it does not train on customer requests (their models page); we do not rely on that. It is opt-in per click; nothing runs automatically after a run. |
| S8 | **Tests never call the network.** A local HTTP fixture speaks the System One shape. The real endpoint is covered only by an opt-in smoke test (`STAGEFLOW_JEV_SMOKE=1` plus a key). |
| S9 | **Scope not in this release:** auto-sorting on run completion, user-defined buckets or failure types, learning from the author's corrections, sorting passed-but-flaky results, CLI/MCP write of suggestions. CLI/MCP get read access to suggestions and a `sort` action. |

## 4. API contract (A = backend, B = UI; both build to this)

New routes (all project-scoped like existing eval routes; wire names snake_case):

- `POST /api/eval-runs/:id/failures/sort` body `{ classifier?: "auto"|"jev"|"judge", only_unsorted?: boolean (default true), limit?: integer (default 200) }` → `200 { batch_id, classifier, model, sorted, skipped, failed, triage_cost_usd, suggestions: Suggestion[] }`. Synchronous (a few seconds; concurrency 4 inside). 409 `EVAL_RUN_ACTIVE` if the run is still running; 422 `EVAL_CLASSIFIER_UNAVAILABLE` (`{ missing: "typesafe_key"|"judge_model" }`); 404 `EVAL_RUN_NOT_FOUND`.
- `GET /api/eval-runs/:id/failures/suggestions?status=` → `{ items: Suggestion[], summary: { by_bucket: {agent_wrong, grader_wrong, case_wrong, unclear}, by_type: Record<string, number>, pending, accepted, dismissed, low_confidence } }`.
- `POST /api/eval-runs/:id/failures/suggestions/accept` body `{ ids?: string[], min_confidence?: number, bucket?: Bucket }` (bulk accept; `min_confidence` default 0.7 when no `ids`) → `{ accepted, tagged }`.
- `POST /api/eval-runs/:id/failures/suggestions/dismiss` body `{ ids: string[] }` → `{ dismissed }`.
- `GET /api/eval-runs/:id/failures/status` → `{ classifiers: { jev: { available, model, reason? }, judge: { available, model, reason? } }, default: "jev"|"judge"|null }` (used by the button to enable or explain).
- The existing result detail response (`GET /api/eval-runs/:id/results/:case`) gains `repeats[].suggestion: Suggestion | null`.

`Suggestion` = `{ id, case_id, repeat_index, source: "jev"|"judge", bucket, failure_type, confidence, bucket_probabilities: Record<Bucket, number>, grader_false_alarms: Array<{ grader_id, probability }>, model, prompt_version, status, created_at }`.

Existing `stats.failure_types` gains no new numbers (the UI must not compute statistics): the suggestions `summary` above is computed server-side in `stats.ts`-adjacent read code (`src/evals/read/`), hand-computed tests.

## 5. UI (B)

- **Failure types card (Overview):** header button **Sort failures** (disabled with a reason when no classifier is available; shows the classifier name). After sorting: a **Suggested** section: bucket bars (agent / grader / case / unclear), with counts, failure-type rows underneath, each row clickable (filters Cases to those results), and **Accept all above 70%** and **Review suggestions** actions. Accepted suggestions flow into the existing tag groups.
- **Cases tab:** a bucket chip per failed row, filter by bucket and by "needs review".
- **Case drawer, Grades and review:** a suggestion line ("Jev suggests: grader wrong · false alarm on never-promises-outcomes · 91%") with **Accept** and **Dismiss**, above the existing tag field. Accept fills the tags; the author can still edit them.
- Copy, states: spinner with count while sorting, error for 422 with the add-a-key instructions, empty state, low-confidence styling not by color alone. Follow `ui/AGENTS.md`. No design file in this release (build from existing components).

## 6. Stories

| # | Story | Blocked by |
|---|---|---|
| F1 | Backend: `src/evals/triage/` (types, `JevClassifier` with injectable `fetch`, `JudgeClassifier`, state builder, bucket/type constants, prompt version), credential lookup, migration 017 + store methods, read models and summary, routes in `evalRoutes.ts`, accept/dismiss writing tags, MCP read tool + `sf eval sort` and `sf eval suggestions`, tests with a local System One fixture, docs (`docs/evals.md` section, `docs/console-evals.md` pointer, `docs/yaml-catalog.md` none, `AGENTS.md` rule lines, CHANGELOG Unreleased) | none |
| F2 | UI against the contract: client types and functions in `ui/src/api/`, Failure types card, Cases filter, drawer suggestion line, tests with mocked client | contract only (parallel with F1) |
| F3 | Integration check on the running container with the Taskboard run: sort with the `judge` backend now, with `jev` when a key exists; report the buckets compared with the hand-sorted examples in the lesson (m006, m005, t013, t007) | F1, F2 |
