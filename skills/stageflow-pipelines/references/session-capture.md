# Capture a session

Turn work that already happened into a pipeline. The default shape is a straight line of stages. Add a gate only where a person decided something. On a validation failure, repair the files. Do not delete them.

## Contents

- [Pick the source](#pick-the-source)
- [Extract](#extract)
- [Map](#map)
- [Write and repair](#write-and-repair)

## Pick the source

Use the first source that applies.

1. **This conversation.** The history already in context is the source. Do not read a transcript file for the chat you are in.
2. **A file or paste the user gives.** Use that text and nothing else.
3. **The newest transcript on disk.** From this skill's directory:

   ```
   node scripts/locate-session-transcript.mjs
   ```

   `--cwd` and `--home` override the directory and the home used for the search. `--path <file>` checks one file and skips the search.

   Success is `{"ok":true,"path":"...","source":"claude-code"|"codex"|"pi"|"explicit"}`. Show that path to the user before you read it. Failure is `{"ok":false,"reason":"not_found"}` or `"unreadable"`. Then ask for a file or a paste. Stores and the encoding rules are in [transcript-sources.md](transcript-sources.md). Do not open Cursor or OpenCode databases.

Run `node scripts/check-provider-gate.mjs` before choosing a model. `{"ok":true}` means some provider is configured. `{"ok":false,"reason":"no_provider_configured"}` or `"sf_not_found"` means you still draft and validate, with `model: CHANGE_ME/<provider-model>`, and you say so. Running the pipeline is `stageflow-operate` and needs a yes.

## Extract

Keep the phases that produced the result the user would want again. For each phase, note the outcome that was checked, the input it needed from the previous phase, and whether a person approved, rejected or redirected.

Drop one-off dead ends, tool noise, and anything that is a secret value. A token, a key or a password never goes into a prompt, a task or a filename. A credential the stage must use becomes a `secrets:` name. See [capabilities.md](capabilities.md#secrets).

## Map

Straight line, in the order the work actually happened. One stage per phase that had its own checkable outcome. Split a phase that mixed research with edits, or review with fixing.

| What the session did | What to write |
|---|---|
| The next phase started when this one finished | `route: [{ to: <next> }]` and `entry: true` on the first stage |
| A person accepted or rejected before the work counted | A gate. Load-bearing when the next phase did not start until they accepted: `gate_kinds` plus `verify: [{ type: gate, kind }]`. Advisory `gate_kinds` only when they answered a question and the work would have continued either way. |
| The same phase was redone after a failed check, and redoing it was safe | An after-phase `verify` and `on_verify_fail: { mode: repair, max_attempts: 2, retry_safety: idempotent }` on the pipeline entry |
| A send, publish or push might already have happened | `on_verify_fail: { mode: manual, retry_safety: side_effecting }`, and usually a confirm gate |
| The phase edited files in a checkout | `verify` `checkout_changes` and a required `changed_files` string array. See `assets/examples/session-capture/implement.yaml` |
| The user chose between two next steps | An exclusive `if` on a required field, not a second pipeline |

Do not add a loop, a fan-out or a Clone Chain unless the session actually worked that way. Gate kinds, route and verify shapes are in [catalog-mapping.md](catalog-mapping.md) and [yaml-reference.md](yaml-reference.md).

`assets/examples/session-capture/` is the straight-line case: `research`, then `implement` with `checkout_changes`. It has no gate because that captured session had no human decision. Add one when yours did.

## Write and repair

Continue at step 3 of New pipeline in the skill: pick a free id, write the files, then the check-validate-repair loop.

```
node scripts/resolve-catalog-id.mjs --text "<phrase>" --dir <directory> --kind pipeline
node scripts/resolve-catalog-id.mjs --text "<phase name>" --dir <directory> --kind stage
```

The script prints `{"id":"..."}`, kebab case, not already used as a top-level `id` in that directory. Use the same id for the pipeline filename stem, the stage filename stem, the stage file `id` and the pipeline entry `id`.

Write under a `catalog.pipelines` root. Add a task when the user will start runs from the console, and make `input` satisfy the entry stage. Then:

```
node scripts/check-catalog-keys.mjs --pipeline <pipeline-path> [--task <task-path>]
sf validate --pipeline <pipeline-path> --strict --json
```

If either reports an error, look the code up in [finding-codes.md](finding-codes.md), edit the files, and run both again. Leave the files in place while you repair. Deleting the package and starting over throws away a draft that only needs a key moved or a schema widened. Stop when validate exits 0. `pipeline.model_applies` is expected. Report the paths, the stages, and any gate you added because a person decided.
