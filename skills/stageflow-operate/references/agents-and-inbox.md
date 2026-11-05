# Agents and Inbox

Operate sessions, approvals, and schedules. Changing an agent definition (instructions, tools, model, memory, channel, or the schedule block) is the `stageflow-agents` skill. This file does not create, save, or archive an agent.

Every `sf agents` subcommand talks to the Host for the project in the current directory and starts a Host when one is not up. There is no offline mode. Pass `--json`.

Confirm before `sf agents chat` and `agent_chat` (they call the model) and before `approve_agent_action` (show the pending action first). Confirm before `stop_agent_session`. Enabling an agent whose definition has a schedule lets that schedule start sessions on its own.

## Contents

- [Inbox and approvals](#inbox-and-approvals)
- [Sessions](#sessions)
- [Schedules](#schedules)
- [What stays in stageflow-agents](#what-stays-in-stageflow-agents)

## Inbox and approvals

Pending approvals across agents have no CLI verb and no MCP tool:

`GET /api/agents/approvals`

The body is `{ "approvals": [ ... ] }`. Each item is a pending approval plus `agentId`. Fields include `id`, `sessionId`, `turnId`, `tool`, `payload`, `status`, `createdAt`, and `expiresAt`. Eval sessions are excluded. Use it when the user asks what is waiting for a decision across agents. Approvals stay on this route.

What is open across agents:

`GET /api/agents/sessions`

Optional query `agent` and `status`. The body is `{ "sessions", "nextCursor", "stats" }`, the same document as one agent's session list. Eval sessions stay hidden. There is no CLI verb and no MCP tool.

There is no MCP "list approvals" tool. Pending work for one session is `pendingApproval` on `get_agent_session` (MCP) or `sf agents session <id> <sessionId> --json`. Read `tool` and `payload` and show them to the user before you approve. If the payload contains a secret, summarize the action and do not paste the secret back into chat.

| Decision | MCP | CLI |
|---|---|---|
| Approve | `approve_agent_action` with `{ "id", "sessionId" }` | `sf agents approve <id> <sessionId> --json` |
| Deny | `deny_agent_action` with the same arguments | `sf agents deny <id> <sessionId> --json` |

Success includes the approval and its `tool`. Deny tells the agent the action was refused. Both act as the operator. Do not approve an action the user has not accepted.

`sf agents list --json` is `{ "agents": [ { "id", "name", "enabled", "revision", "issues" } ] }`. An agent with issues is not safe to chat. Report the issues and hand definition edits to `stageflow-agents`.

## Sessions

| Want | MCP | CLI |
|---|---|---|
| List one agent's sessions | `list_agent_sessions` with `id`, optional `status`, `search`, `limit` (max 100), `cursor` | `sf agents sessions <id> [--status <status>] --json` |
| One session, including the transcript and approvals | `get_agent_session` with `id` and `sessionId` | `sf agents session <id> <sessionId> --json` |
| Stop the turn that is running | `stop_agent_session` | no CLI verb |
| Send a message | `agent_chat` with `id`, `message`, optional `sessionId` | `sf agents chat <id> --message <text> [--session <sessionId>] --json` |

`status` is `open`, `running`, `waiting`, `held`, or `closed`. The list document is `{ "sessions", "nextCursor", "stats" }`. Each session includes `turnCount`, `inputTokens`, `outputTokens`, and `costUsd` (null when the session has not reported a cost). The CLI passes only `--status`. Search, limit, and cursor are MCP arguments (`limit` max 100).

`stop_agent_session` stops the current turn. The session stays open. There is no `sf agents stop`.

`agent_chat` and `sf agents chat` spend money. With `--json`, the CLI prints the finished session object. Without `--json` it streams the reply to the terminal. A stream that closes before a `done` frame fails with `agent.stream_closed`.

Eval sessions (`source: "eval"`) are hidden from these lists. Do not go looking for them in the Inbox.

## Schedules

A schedule lives on the agent definition (`schedule.cron`, optional `schedule.timezone`). Reading it is `sf agents get <id> --json` or MCP `get_agent`. Writing it is `save_agent` in the `stageflow-agents` skill.

The Host fires due schedules about every 30 seconds (`STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS`). The next fire across agents is `activity.next_agent_schedule_at` on `GET /api/health`. MCP `get_health` does not include that field. A null means nothing is scheduled.

To see whether a schedule is producing sessions, list sessions and look at `source: "schedule"`. Disabling the agent (`sf agents disable <id>`) stops new scheduled sessions. That does not edit the cron. Re-enable with `sf agents enable <id>` only when the user wants the schedule to run again.

## What stays in stageflow-agents

Use `stageflow-agents` for `create_agent`, `save_agent`, `archive_agent`, revisions, tools, and the text of the definition. This skill can:

| CLI | MCP | Role |
|---|---|---|
| `sf agents enable <id>` / `disable <id>` | `enable_agent` / `disable_agent` | Turn the saved definition on or off. |
| `sf agents history <id>` | `list_agent_revisions` | Read revisions. |
| `sf agents restore <id> <revision> --base <current>` | `restore_agent_revision` | Put an old revision back. `--base` is the revision you read. If the agent moved, the restore is refused. |
| `sf agents validate <file.agent.yaml>` | `validate_agent` | Check a file. This does not save it. |

`sf agents` has no `create`, `save`, `archive`, or `stop` verb. Host errors with `--json` are `{ "code", "message", "issues" }` and exit `1`.
