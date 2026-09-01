# Validate and report

After the pipeline and stage files exist, validate them before telling the human authoring is complete.

## Command

Default — always available:

```
sf validate --pipeline <written-path> --strict
```

MCP `validate` is allowed only when [`../../stageflow/scripts/detect-host.mjs`](../../stageflow/scripts/detect-host.mjs) reports a host up. From this skill directory:

```
node ../stageflow/scripts/detect-host.mjs
```

| stdout | next |
|---|---|
| `up <baseUrl>` | MCP `validate` with `{ "pipeline": "<written-path>", "strict": true }` is allowed |
| `down <baseUrl>` | stay on the CLI command |

Do not write a second probe. MCP-vs-CLI policy: [`../../stageflow/references/control-surface.md`](../../stageflow/references/control-surface.md). Both paths return the same `ValidationResult` shape (`ok`, `summary`, `findings[]`).

## Failure

When `ok` is false or the CLI exits non-zero, print each finding (severity, code, path, message). Fix the offending pipeline or stage file. Re-validate. Repeat until `ok` is true. Never report authoring complete on a failing validate.

## Success

When validate exits 0 / `ok: true`, print:

1. Pipeline id and pipeline path.
2. Every stage path written in this invocation.
3. Name `stageflow-run` if the human wants to execute the pipeline.

Do not write a `*.task.yaml`. Do not start a run here.
