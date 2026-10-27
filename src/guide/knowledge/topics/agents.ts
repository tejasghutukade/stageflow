import type { GuideKnowledgeTopic } from "../index.js";

export const agentsTopic: GuideKnowledgeTopic = {
  id: "agents",
  title: "Project agents: definition, tools, approvals, reach and limits",
  summary:
    "Agent YAML fields, tool grants, ask-first approvals, memories, one inbound channel, schedule, web chat, limits, sub-agents, revisions, and the rules that an agent cannot grant beyond what it holds or edit itself.",
  body: `# Project agents

An agent is one file, \`agents/<id>.agent.yaml\`. It is a configured assistant that talks over many turns. It is not the stage \`agent:\` field (that picks the Pi or Claude backend for stages).

Minimum: \`id\`, \`name\`, \`instructions\`. Unknown keys are rejected (\`agent.unknown_field\`).

## Fields

- \`id\`: \`^[a-z][a-z0-9_]{0,63}$\`, must match the file name, fixed after create. Made from \`name\` when omitted. \`sessions\`, \`approvals\`, \`new\` are reserved.
- \`name\` (1–120), \`description\` (≤ 500), \`greeting\` (≤ 500, shown on web chat), \`instructions\` (the system prompt).
- \`enabled\`: default \`false\`. **A new agent is always created disabled**; enabling is a separate step (\`enable_agent\`) and its own revision. Enabling is refused while the file has issues.
- \`project_context\`: adds the project's \`AGENTS.md\` (or \`CLAUDE.md\`) to the prompt, first 20,000 characters.
- \`model\`: \`{ backend: pi|claude, id?, thinking: off|low|medium|high }\`. Only \`pi\` runs; \`claude\` saves with a warning and sessions fail. \`id\` defaults to the project default model.
- \`execution\`: \`trusted-local\` (default). \`sandbox\` is not installed yet; sessions fail.
- \`tools\`: \`builtin\` groups (\`read\` = read, grep, find, ls; \`write\` = write, edit; \`shell\` = bash), \`builtin_tools\` (single tools), \`mcp\` (\`{ server: [tool names] }\` or \`["*"]\`), \`skills\`, \`stageflow\` (\`{ groups, tools }\`), \`browser\` (stored, not wired to anything yet).
- \`approvals\`: \`ask_first\` (tool ids the agent holds: \`edit\`, \`bash\`, \`stageflow.<tool>\`, \`<server>.<tool>\`, \`agent:<id>\`), \`approvers.operators\` (default true), \`timeout_minutes\` (default 30), \`on_timeout\` (\`skip\` default, or \`deny\`). \`approvers.channel_ids\` is reserved and ignored; never set \`operators: false\`.
- \`sub_agents\` (agent ids, not itself) and \`sub_agent_depth\` (1–5, default 1).
- \`guardrails.block_patterns\`: regexes checked on the finished reply; a match fails the turn and the reply is not sent. Streaming is held back for agents with patterns.
- \`evals.groundedness\`, \`observability\` (\`capture: off|metadata|full\`, \`otlp\`).
- \`channel\`: \`{ connection_id, allow_from }\`. One connection per agent and one agent per connection (\`agent.channel_in_use\`). Empty \`allow_from\` lets nobody in; \`*\` lets anyone in. Entries: email, \`@domain\` (AgentMail), \`+E164\` phone (iMessage), Slack user id \`U…\`/\`W…\`, Telegram \`@username\`.
- \`memories\`: memory ids every session can use. Must already exist (\`agent.memory_unavailable\` blocks save and enable). Sub-agents do not inherit them.
- \`web_chat\`: \`{ enabled, slug, rate_limit_per_minute (1–120, default 10), max_message_chars (1–20000, default 4000) }\`. Agents created through console, API, CLI or MCP start with web chat on and a random slug; the link \`/chat/<slug>\` is the credential. It is live only while the agent is enabled.
- \`schedule\`: \`{ cron, timezone?, message? }\`. The first tick only stores the next run; a missed time fires once.
- \`limits\`: \`session_minutes\` (default 10), \`max_turns\` (default 40), \`cost_usd\` (default none), \`long_context\` (\`summarize\`/\`truncate\`), \`always_on\` (ignores time and turns; cost counts per 24 hours). Limits are checked when a turn starts, not during it.

## Tools and the gate

Every tool call passes one gate: path guard (no writes to \`agents/*.agent.yaml\` or \`$STAGEFLOW_HOME\` through path arguments), then "is it granted", then "ask first". \`bash\` is **always** ask-first when granted and is not path-confined, so an agent with \`bash\` can still change agent files and Stageflow state (\`agent.shell_not_path_confined\` warning). MCP tools appear as \`<server>_<tool>\` with grant id \`<server>.<tool>\`; Stageflow tools as \`stageflow_<tool>\` with grant id \`stageflow.<tool>\`; sub-agents as \`agent_<id>\`.

Stageflow tool groups: \`discover\`, \`runs.read\`, \`runs.control\`, \`runs.cleanup\`, \`gates.read\`, \`triggers\`, \`agents.read\`, \`agents.manage\`, \`agents.cleanup\`, \`agents.converse\`, \`evals.read\`, \`evals.run\`, \`evals.write\`, \`evals.cleanup\`, \`pipelines.author\`, \`connections\`, \`connections.cleanup\`, \`memories\`, \`memories.cleanup\`. \`gates.decide\` and \`get_started\` are operator-only and cannot be granted (\`agent.stageflow_operator_only\`). Destructive tools have their own \`*.cleanup\` groups. The console turns on ask-first for every non-read tool when you tick a group.

## Asking first

A call to an ask-first tool pauses the turn until a person decides in the Inbox, the session page, \`sf agents\` or MCP. One pending approval per session. An identical call approved once is not asked again in that session. Pending approvals do not survive a Host restart. Channels cannot approve.

## Rules for agents that manage agents

- An agent cannot hand out more than it holds: \`create_agent\`, \`save_agent\`, \`restore_agent_revision\` and \`enable_agent\` called by an agent refuse any tool, MCP tool, MCP wildcard, skill or browser grant the caller does not hold, and refuse a definition that drops an ask-first the caller itself must obey.
- An agent cannot edit, restore or archive its own definition.
- An agent cannot decide approvals on its own sessions, and no agent can decide approvals at all.

## Revisions and sessions

Every valid save is a revision with a source. A save based on an old revision is refused (\`agent.conflict\`). Identical saves are no-ops. Restore saves an old revision as the newest. Removing the file or \`archive_agent\` archives the agent (history kept). A session stays on the revision it started with; edits reach new sessions only.

## Reach

Console only by default, plus web chat for agents created through tools. Inbound channels: AgentMail and iMessage (the Host keeps a stream open, no public URL needed), Slack and Telegram (webhook at \`/api/agent-inbound/<connection id>\`, needs an \`inboundSecret\` and a URL the provider can reach). WhatsApp is send-only. On a channel the system sends the reply; an unknown delivery outcome is never resent and fails the turn as \`agent.reply_undelivered\`.

## Tools for agents

\`list_agents\`, \`get_agent\`, \`validate_agent\`, \`create_agent\` (always disabled), \`save_agent\`, \`enable_agent\`, \`disable_agent\`, \`restore_agent_revision\`, \`list_agent_revisions\`, \`diff_agent_revisions\`, \`archive_agent\`, \`agent_chat\`, \`get_agent_session\`, \`list_agent_sessions\`, \`stop_agent_session\`.
`,
};
