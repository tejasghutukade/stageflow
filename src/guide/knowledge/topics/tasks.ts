import type { GuideKnowledgeTopic } from "../index.js";

export const tasksTopic: GuideKnowledgeTopic = {
  id: "tasks",
  title: "Tasks: what a run starts from",
  summary:
    "Task file fields (id, goal, context, constraints, input, checkout, repository, ref), how input meets the entry stage, standalone vs pipeline tasks, and dynamic tasks built by triggers.",
  body: `# Tasks

A task file is \`<id>.task.yaml\`. Every run is one pipeline plus one task. The task says what this run should do; the pipeline says how.

## Fields

| Field | Required | Meaning |
|---|---|---|
| \`id\` | yes | Task identifier. Tools expect lowercase kebab-case, 1 to 64 characters. |
| \`goal\` | yes | What the run should accomplish. Every stage sees it. |
| \`context\` | no | Background for the agents. |
| \`constraints\` | no | Boundaries the agents must respect. |
| \`input\` | no | Structured object matched against each entry stage's \`io.input.schema\`. Omitted means \`{}\`. |
| \`checkout\` | no | Path (relative or absolute) to an existing working folder. Conflicts with \`repository\`. |
| \`repository\` | no | GitHub \`owner/repo\`; the Host creates its own worktree. Requires \`ref\`. |
| \`ref\` | with \`repository\` | Branch, tag or SHA. |

Do not set both \`checkout\` and \`repository\`. The loader also accepts \`checkout: { branch, base }\` (Stageflow creates or reuses a git worktree), \`run_branch_template\` and \`git_identity\`; these are not in the public field table, so prefer the documented forms.

## How \`input\` meets the pipeline

- If an entry stage's \`io.input.schema\` requires fields, the task must provide them under \`input\`. A missing or wrong \`input\` makes run start fail with \`task.invalid_shape\`, even though validating the task file alone succeeds.
- A prose-only task (no \`input\`) is fine when the entry stage's input schema is an empty object.
- Non-entry stages also see the whole task in their prompt, plus their parents' envelopes.

## Standalone task vs pipeline task

- \`create_task_file\` writes a standalone catalog task (\`directory\`, \`id\`, \`goal\`, optional \`context\`, \`constraints\`, \`checkout\`, \`repository\`, \`ref\`). It is not tied to a pipeline; any pipeline can run with it. \`update_task_file\` replaces it by id (\`goal\` required; pass \`null\` or empty to drop an optional field).
- \`create_task\` / \`edit_task\` write the task that sits beside a pipeline package (same folder).
- \`import_task_file\` turns a GitHub issue into a task (title becomes goal and id). It calls GitHub.
- Neither tool set writes \`input\` as a named argument on standalone tasks; to set \`input\` on a pipeline task pass it inside \`body\` of \`create_task\` / \`edit_task\`.

## Tasks and triggers

- A trigger with \`task: <id>\` (catalog mode) always runs that catalog task. Supplying a different task at fire time is refused (\`trigger.task_override_not_allowed\`).
- A trigger without \`task\` (dynamic mode) needs a task at every fire. GitHub pull request triggers build one from the PR (\`goal\` summarizes it, \`input\` holds \`action\`, \`number\`, \`title\`, \`url\`, \`author\`, \`repo\`, \`updatedAt\`). Webhook triggers put the JSON body in \`input\`. Email triggers put \`from\`, \`subject\`, \`date\`, \`text\` in \`input\`. A manual fire must pass a task inline, otherwise \`trigger.task_required\`.
- A schedule trigger has nothing to build a task from, so it needs a catalog task.
- When the task is built from an event, design the entry stage's \`io.input.schema\` around that event shape.

## Repository-bound tasks

With \`repository\` + \`ref\`, the stage works in a Host-owned worktree. Repository-bound stages read the repository's own \`.mcp.json\` and \`.pi/skills\` as untrusted workspace content and never see console MCP servers or console secrets. Evals cannot use a checkout or repository: eval cases run with neither.

## Starting a run

The console's Start a run picks a task and a pipeline (\`#/new\`). Tools: \`start_run\` (pipeline and task), \`run_stage\` (one stage), \`rerun\`. The CLI is \`sf run --pipeline <path> --task <path>\` (paths, not ids).
`,
};
