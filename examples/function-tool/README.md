# Function tool

One stage that exposes the project function `total_counts` as a tool. The agent supplies a `counts` array. The function returns `{ total }`. It does not read an envelope and it declares no file, env, or API capability.

The definition lives at the project root, `functions/total_counts.function.yaml`. The same `tools.functions` entry (`id` plus `grants`) is what an agent definition uses.

## What this demonstrates

- A tool is `kind: tool` and adds `tool_name`, `tool_description`, `input_schema`, and an optional `output_schema`.
- The schema root is an object. Nesting stops at 8 levels, and one schema object has at most 64 properties.
- A stage attaches it on the stage body under `tools.functions`. An empty `grants` list matches a function that declares no capabilities.

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/function-tool/total-counts.pipeline.yaml
sf run \
  --pipeline examples/function-tool/total-counts.pipeline.yaml \
  --task examples/function-tool/total-counts.task.yaml
```

Validate should succeed. The run calls a model, which calls `total_counts`, then emits `{ "total": <sum> }`.

Open **Functions** in the operator console to edit the source, or attach the tool from the stage body in the pipeline inspector. On an agent, the same entry is edited on the agent form.
