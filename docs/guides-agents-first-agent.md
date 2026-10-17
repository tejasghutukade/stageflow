# Guide: create your first agent

An agent is a project-owned definition (`agents/<id>.agent.yaml`) that answers people in conversations. This guide takes one from nothing to a first reply. Reference: [Agents](agents.md), [YAML catalog — Agents](yaml-catalog.md#agents-agent-yaml).

## 1. Create it

**Console.** Open **Agents** (`#/agents`) and choose **New agent**. Describe the agent in the chat column ("answer questions about our docs, read files but never edit them") or edit the config directly. **Save agent** writes `agents/<id>.agent.yaml`. The id comes from the name (`Support bot` becomes `support_bot`, suffixed `_2`, `_3` on a clash; `sessions`, `approvals` and `new` are reserved).

**Files.** Write the YAML yourself; the file name is the id:

```yaml
# agents/helper.agent.yaml
id: helper
name: Helper
instructions: Answer questions about this repository. Be brief.
tools:
  builtin: [read]
```

**CLI / API / MCP.** There is no `sf agents create`. Use the [`create_agent` MCP tool](mcp.md#agent-tools) or the REST API.

Every new agent is **disabled**. Nothing runs until you enable it.

## 2. Check it

`sf agents validate agents/helper.agent.yaml` (or the editor's live validation) prints errors and warnings with field paths. Warnings do not block a save; common ones:

| Warning | Meaning |
|---------|---------|
| `agent.mcp_server_unknown` | A server under `tools.mcp` is in neither the project `.mcp.json` nor the servers saved from the console |
| `agent.connection_unknown` | `channel.connection_id` is not a known connection |
| `agent.channel_nobody_allowed` | `allow_from` is empty, so nobody can message the agent |
| `agent.channel_open_to_anyone` | `allow_from` contains `*` |
| `agent.shell_not_path_confined` | `bash` is granted; it is not confined by the path guard and always asks first |
| `agent.channel_approvers_unused` | `approvals.approvers.channel_ids` is set; approving from a chat channel is not supported yet |

## 3. Enable and talk to it

- Console: open the agent and choose **Enable agent**, then start a session from the agent page.
- CLI: `sf agents enable helper`, then `sf agents chat helper --message "What does this repo do?"`. The reply streams; `session <id>` goes to stderr so you can continue with `--session`.
- Web chat: every agent created from the console, API, CLI or MCP starts with a shareable page. See [Set up web chat](guides-agents-web-chat.md).

## 4. Decide what it may do

By default an agent has no tools. Grant what it needs under `tools:` (see [Agents — Runtime](agents.md#runtime)) and list the tools that need a person's decision under `approvals.ask_first`. A call to an ask-first tool pauses the turn until you approve or deny it in the Inbox, on the session page, with `sf agents approve|deny`, or over MCP. `bash` always asks first when granted.

## 5. Put it where people are

| You want | Guide |
|----------|-------|
| A link anyone can open | [Web chat](guides-agents-web-chat.md) |
| Email replies | [Email agent (AgentMail)](guides-agents-email.md) |
| iMessage | [iMessage agent](guides-agents-imessage.md) |
| Slack | [Slack agent](guides-agents-slack.md) |
| Telegram | [Telegram agent](guides-agents-telegram.md) |
| A turn on a timetable | [Schedule an agent](guides-agents-schedule.md) |

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| `agent.disabled` | The agent is disabled. Enable it |
| `agent.invalid` on save | The file does not validate; the last valid revision stays in use. Read the field paths in the issues |
| `agent.conflict` | You saved from an older revision. Reload and apply your change again |
| The list shows **Needs setup** | A required piece is missing (for example an MCP server). The first issue is shown under the agent |
