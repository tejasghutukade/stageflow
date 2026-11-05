# Reuse or codify

When the user describes a request they repeat, match it to a catalog pipeline before writing a new one. A pipeline that validated last month can fail today. Re-validate before you hand it off to run.

## Match

List what the catalog already has. MCP `list_pipelines` and `list_tasks` when the Host is this project, otherwise read `stageflow.yaml` `catalog.pipelines` and `catalog.tasks` and glob `**/*.pipeline.yaml` and `**/*.task.yaml` under those roots. Files outside the roots still validate by path and do not show in the console.

Compare the request to each pipeline's stages, entry input and gates, not to its title alone. Read the pipeline and its `uses:` files, or MCP `read_pipeline`.

| How close | What to do |
|---|---|
| The existing pipeline does this job | Re-validate it, then hand off. Do not write a second copy. |
| It would do the job with a small change | Offer to edit it. Follow Edit or repair in the skill. A near-duplicate is harder to keep than one pipeline. |
| Nothing matches, and this session already did the work | [session-capture.md](session-capture.md). |
| Nothing matches, and there is no history to capture | New pipeline, from the closest folder in `assets/examples/`. |

Ask once when two pipelines both look right. If the user names one, use that one.

## Re-validate before reuse

From the project root, on the pipeline you intend to run:

```
node scripts/check-catalog-keys.mjs --pipeline <pipeline-path> [--task <task-path>]
sf validate --pipeline <pipeline-path> --strict --json
sf validate --task <task-path> --json
```

Fix every error with [finding-codes.md](finding-codes.md). A previous successful run is not a substitute. `pipeline.model_applies` and an exhaustive `pipeline.route_all_gated` can stay.

When the pipeline uses `requires`, `secrets`, `mcp` or `channels`, also run `sf doctor --pipeline <pipeline-path> --json` or MCP `preflight` with `{ pipeline }`. A saved login and `browser.check` are not covered by `sf doctor` or `preflight`. Validate does not prove a tool is installed, a secret has a value, or a server connects. Tell the user any gap. Do not paper over it by deleting the field.

Confirm the task `input` still satisfies the entry stage. The validator does not. The self-check script does, when you pass `--task`.

## Hand off

After validate exits 0, the next step is a run. That calls models and is `stageflow-operate`. Ask the user before anyone starts it. Report the pipeline id, the path, the task path, and any warning you left on purpose.

If they want the same request on a schedule, a webhook or a pull request, add a trigger with `enabled: false` as in [capabilities.md](capabilities.md#triggers), and let `stageflow-operate` enable it after they agree. If they want another agent to call it, that is an A2A publication in [capabilities.md](capabilities.md#a2a-publication), also only after they agree.
