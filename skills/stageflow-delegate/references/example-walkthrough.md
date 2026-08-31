# Example walkthrough

Content walkthrough. No live harness session is required.

Scratch catalog at first sight:

| path | id | task `goal` (if readable) |
|---|---|---|
| `pipelines/hello.pipeline.yaml` | `hello` | Draft a one-page brief |
| `pipelines/plan-review.pipeline.yaml` | `plan-review` | Prove a review loop |

## First sight

Request: "Every week I gather sources, summarize them, and send a digest. Make that a reusable pipeline and run it."

[pattern-detection](pattern-detection.md) tokens include `gather`, `sources`, `summarize`, `send`, `digest`. Neither `hello` nor `plan-review` shares a distinctive topic token. Band: **no match**. This chat has not already done that work. [authoring-or-run](authoring-or-run.md) opens `stageflow-author`, then names `stageflow-run` on the written pipeline (id `research-digest`, path `pipelines/research-digest.pipeline.yaml`). One pipeline is authored. None is invented a second time.

If this session had already gathered, summarized, and sent — with that history still in chat or a pointer the human supplied — the same no-match would open `stageflow-session-capture` instead, then `stageflow-run`.

## Second sight

Same catalog, plus `pipelines/research-digest.pipeline.yaml` (`id: research-digest`).

Request: "Run the weekly research digest."

Tokens include `research`, `digest`. Exact topic overlap on one candidate's kebab `id`. Band: **match**. [authoring-or-run](authoring-or-run.md) opens `stageflow-run` only. No second pipeline is written.

## Ordinary request

Request: "Fix the typo in README." This skill is not opened. The harness's builtin subagent does the edit. Builtin subagents stay available.
