import type { GuideKnowledgeTopic } from "../index.js";

export const limitationsTopic: GuideKnowledgeTopic = {
  id: "limitations",
  title: "Limitations: what Stageflow does not do",
  summary:
    "Known gaps and sharp edges, each with what the user sees and the workaround: missing deletes, memory and channel limits, schedule triggers without a task, edit_pipeline keys, agent and eval restrictions, operator-only actions, backend gaps.",
  body: `# Limitations

Each item: the limit, what the user sees, and the workaround.

## Deleting and renaming

- **No delete for catalog triggers.** There is no tool, API route or console delete. Workaround: \`set_trigger_enabled\` false; to remove it, delete the \`*.trigger.yaml\` file by hand.
- **No delete for pipelines, stage files, tasks, evals or datasets** through tools or the API. Workaround: delete the files by hand. What can be deleted: runs, eval runs, memory cards, connections, console MCP servers; agents are archived.
- **No delete for a whole memory, and its description cannot change after create.** No tool or route exists. Workaround: create a new memory with a new id, attach it instead, and stop using the old one.
- **Ids are fixed.** Agent ids cannot change (\`agent.id_immutable\`); \`update_trigger\` cannot change a trigger id; changing a connection id makes a new connection.

## Memories

- **Guide and operators cannot add a memory card.** \`write_memory_card\` only replaces an existing card (\`MEMORY_CARD_NOT_FOUND\` otherwise); the console cannot create cards either. Only stage and agent sessions add cards. Workaround: put seed facts on the cover page, or let the first run add cards.
- **Sessions cannot delete cards** or read previous copies. Only one previous copy is kept and there is no restore.
- **Caps:** 64,000 characters per cover or card, 200 cards (\`MEMORY_TOO_LARGE\`, \`MEMORY_TOO_MANY_CARDS\`).
- **No per-stage memories.** A pipeline's memories go to every stage.

## Channels and connections

- **One channel per stage.** A second entry, or one inherited from a pipeline default, fails with "a stage can use one channel for now". Workaround: two stages, or one AgentMail connection with several \`to\`/\`cc\` recipients.
- **Stage channels are send-only.** A stage never receives messages. WhatsApp is send-only for agents too. An IMAP email account cannot be an agent channel.
- **Connection secrets cannot be read back.** Tools and screens show only whether a secret comes from \`env\` or \`store\`. Workaround: replace it with \`update_connection\`.
- **An unknown send outcome is never resent** (\`CHANNEL_SEND_OUTCOME_UNKNOWN\`). Workaround: confirm with the recipient, then send deliberately with a new key.
- **Channels and memory tools are Pi-only.** On the Claude backend such stages fail at start.

## Triggers

- **A schedule trigger needs a catalog task.** \`create_trigger\` accepts a schedule without \`task\`, but every automatic fire fails with \`trigger.task_required\`. The console blocks it. Workaround: always set \`task\`.
- **Dynamic triggers cannot be fired from the console** (Fire is disabled). Workaround: \`fire_trigger\` with an inline \`task\`.
- **Only some event sources run.** GitHub (pull requests only, first poll fires nothing), signed webhook, IMAP email. Any other \`event.source\` is never watched. Email \`match\` is exact (no substring) and has no attachments; a new email trigger may need a Host restart. Webhooks need a reachable Host (loopback by default). The console cannot edit \`event.config\`; set it with \`create_trigger\`/\`update_trigger\` or YAML.
- **Automatic triggers need a running Host** (\`sf ui\`, \`sf mcp\` or Docker).

## Authoring tools

- **\`edit_pipeline\` only applies these patch keys:** \`id\`, \`model\`, \`agent\`, \`stages\`, \`schemas\`, \`requires\`, \`memories\`, \`channels\`. Others (\`browser\`, \`include\`) are silently ignored, and \`model\` cannot be cleared. \`stages\` replaces the whole list. Workaround: edit the YAML in the pipeline editor or by hand.
- **\`edit_stage\` merges fields and cannot remove one.** Workaround: \`write_catalog_file\` with the full stage YAML.
- **\`create_stage\` writes the Host default model** into the stage when none is passed, overriding the pipeline default.
- **Standalone task tools have no \`input\` argument** (\`create_task_file\`, \`update_task_file\`). Workaround: \`create_task\`/\`edit_task\` with \`input\` inside \`body\`, or edit the file.
- **No tool to log in to a model provider, add a project MCP server, set an MCP secret or install a skill.** These are done in Settings, the Catalog page or the CLI.

## Agents

- **A new agent always starts disabled.** Workaround: \`enable_agent\` after validating.
- **An agent cannot grant beyond what it holds, cannot weaken an ask-first it is bound by, and cannot edit, restore or archive itself.** The tool returns a refusal naming the extra grants.
- **Not functional yet:** \`model.backend: claude\` and \`execution: sandbox\` (sessions fail), \`tools.browser\` (stored, unused), \`approvals.approvers.channel_ids\` (ignored).
- **\`bash\` is not path-confined** and always asks first.
- **Restarts:** running or waiting turns fail with \`agent.host_restarted\`; pending approvals expire.
- **Cursor models** are refused for agents unless the Host opts in.

## Evals

- **The engine must be installed** (\`sf eval engine install\`, Node 22.22+, about 1.2 GB). Otherwise \`EVAL_ENGINE_UNAVAILABLE\`.
- **One eval run per Host.** A second start fails with \`EVAL_RUN_ACTIVE\`. Workaround: wait or \`cancel_eval_run\`.
- **Judges only from \`anthropic\`, \`openai\`, \`openrouter\`, with an API key** (not OAuth).
- **No checkout, no gates:** cases run without a repository; a stage that asks a person ends \`EVAL_STAGE_NEEDS_INPUT\`.
- **Pipeline overlays are not applied** to an evaluated pipeline stage (entry-level \`mcp\`, \`secrets\`, \`requires\`, pipeline \`channels\`, \`schemas\`, \`include\`).
- **Not built:** whole-pipeline evals, scheduled evals, judge calibration, \`command\` and \`groundedness\` graders, deleting an eval in the console.
- **Agent eval cost cap** is checked before each conversation, so it can be passed by up to \`concurrency\` conversations.

## Operator-only actions

- **Only a person can answer a pipeline gate (\`answer_gate\`), decide a feedback loop at its limit (\`decide_feedback_loop\`), or approve/deny an agent action.** Guide and other agents cannot. Workaround: point the user to the Inbox (\`#/inbox\`).

## Pipelines and runs

- **No run-level cost cap for pipelines.** Use cheaper models, \`timeout_ms\`, and small repair limits.
- **Route \`if\` is limited:** only required scalar fields, no \`exists\`, no else branch, no array indexes.
- **\`on: [failed]\` does not launch a stage after failure.**
- **A clone chain fails on an empty list or one longer than \`clone_cap\`.**
- **Validation does not check provider keys, env vars or live MCP connections.** Those fail at run start.

## MCP, skills, browser

- **OAuth-signed-in MCP servers do not work in pipeline stages.** Use a bearer-token secret.
- **MCP elicitation is not supported.**
- **Browser \`allow_domains\` is not enforced for profile stages**; passkeys and native prompts do not work; a login stage fails on a Host with no screen and no live view; another run waits for a leased profile with no time limit.
- **Hosted multi-user use is not built.** Browser profiles and connections use a single local owner.
`,
};
