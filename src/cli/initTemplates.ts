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
stages:
  - id: hello
    model: anthropic/claude-sonnet-4-5
    system_prompt: Say hello and emit a success envelope.
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

export const HELLO_TASK_YAML = `id: hello
goal: Run the hello pipeline scaffold.
`;
