# Pattern detection

Decide match vs first-sight from the catalog. Listings carry `path`, `id`, and `stages` — no `description` or `title`. Do not invent a list command.

## Roots

Project root is the git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory. Read `stageflow.yaml` there. Walk each `catalog.pipelines` root. Use `catalog.patterns.pipeline` (default `*.pipeline.yaml`). Skip a path whose repo-relative prefix is in `catalog.exclude`.

Manifest missing or unreadable, a listed root missing, or zero pipeline files → **no match**. Not an error.

**Done when** you have a candidate list, or a no-match.

## Host

From this skill directory:

```
node ../stageflow/scripts/detect-host.mjs
```

Script: [`../../stageflow/scripts/detect-host.mjs`](../../stageflow/scripts/detect-host.mjs). Stdout is `up <baseUrl>` or `down <baseUrl>`.

| stdout | catalog |
|---|---|
| `up <baseUrl>` | MCP `list_pipelines`, then `describe_pipeline` on a shortlisted path |
| `down <baseUrl>` | Read `*.pipeline.yaml` under the roots. When a paired `*.task.yaml` is readable, take its `goal` |

A paired task is a `*.task.yaml` in the same directory as the pipeline, or one whose `id` / directory words overlap that pipeline. Skip `goal` when no such file is readable. Host-up listings do not include `goal`.

**Done when** each candidate has `path`, `id`, and (when readable) a task `goal`.

## Score

Split the request, each kebab `id`, and each directory segment under the catalog root into lowercase tokens. Drop empty tokens and generic words (`pipeline`, `stage`, `task`, `run`, `the`, `a`, `an`). Add tokens from a readable task `goal`.

| band | test | next |
|---|---|---|
| match | The request names one candidate's kebab `id`, or exactly one candidate has a strong overlap (a distinctive topic token shared with `id`, directory words, or `goal`) | reuse that pipeline |
| ask once | Two or more candidates are plausible | print `id` + `path` for each; ask which; that answer is the match |
| no match | Zero candidates, or the catalog was empty / unreadable | first-sight |

Exact `id` beats keyword overlap. Do not guess among two-plus. Do not treat a weak shared word (`review`, `send`, `weekly`) as a match when more than one candidate could claim it.

**Done when** the band is match, a human-chosen match, or no match.
