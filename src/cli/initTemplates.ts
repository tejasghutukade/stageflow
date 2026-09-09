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

export const HELLO_PIPELINE_YAML = `id: hello
model: anthropic/claude-sonnet-4-5
stages:
  - id: hello
    system_prompt: Say hello and emit a success envelope.
`;

export const HELLO_TASK_YAML = `id: hello
goal: Run the hello pipeline scaffold.
`;
