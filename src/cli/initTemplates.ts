export const STAGEFLOW_YAML = `version: 1
catalog:
  pipelines:
    - pipelines
  tasks:
    - tasks
  patterns:
    pipeline: "*.pipeline.yaml"
    task: "*.task.yaml"
`;

export const LOUD_MODEL_PLACEHOLDER = "CHANGE_ME/<provider-model>";

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "anthropic/claude-sonnet-4-5",
  openrouter: "openrouter/auto",
  cursor: "cursor/auto",
};

export function resolveInitDefaultModel(
  configuredProviderIds: readonly string[],
): string {
  const ids = [
    ...new Set(
      configuredProviderIds
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (ids.length === 1) {
    const id = ids[0]!;
    return PROVIDER_DEFAULT_MODELS[id] ?? `CHANGE_ME/${id}-model`;
  }
  return LOUD_MODEL_PLACEHOLDER;
}

export function helloPipelineYaml(model: string): string {
  return `id: hello
stages:
  - id: hello
    model: "${model}"
    system_prompt: Say hello and emit a success envelope.
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;
}

export const HELLO_PIPELINE_YAML = helloPipelineYaml(
  "anthropic/claude-sonnet-4-5",
);

export const HELLO_TASK_YAML = `id: hello
goal: Run the hello pipeline scaffold.
`;
