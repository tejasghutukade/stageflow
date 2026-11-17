---
layout: default
title: Console - Agents
---

# Agents in the console

What an agent is, its YAML and its runtime: [Agents](agents.md), [Agent definition](agent-definition.md) and [Agent runtime](agent-runtime.md). This page covers the screens.

## Agent directory (`#/agents`)

One row per agent. Click a row, or move with **↑ / ↓** and press **Enter** or **Space**, to open its page. **New agent** creates one.

| Column | Meaning |
|--------|---------|
| **Status** | **Enabled** (green, accepts sessions), **Disabled** (shown as paused: no new sessions) or **Needs setup** (the definition has an issue, such as an MCP server that is not connected, and cannot be enabled until fixed). A line under the table explains what each means |
| **Reach** | How people get to the agent: the **web chat** link (open or copy), the **channel** provider with its connection (email, iMessage, Slack, Telegram), the **schedule**, or "Console only". Search matches reach too |
| **Tools / Approvals** | The first few tools and ask-first approvals. **View all** opens a dialog with the rest |
| **Sessions, cost** | Sessions in the last 7 days; all-time cost per agent. The page header shows total sessions and total cost across all agents (a dash when no cost is known) |

Filter chips: **All**, **Enabled**, **Disabled**, **Needs setup**.

## Create (`#/agents/new`)

A form beside an **author chat**. Describe the agent; the author fills the form and you review it. The page shows "Ready to save" when name and instructions are present. **Draft YAML** previews the file. A new agent is always created **disabled**.

## Agent page (`#/agents/<id>`)

Header buttons: **Edit agent**, and **Enable agent** or **Disable agent**.

- **Disable agent** asks first. The agent stops accepting new work: no new sessions, and its web chat page and channel stop answering. A turn already running finishes; a waiting approval can only be denied. Nothing is deleted, and you can enable it again.
- A **web chat** card shows the link state: **Live** (share the link), **Waiting for you to enable the agent**, or **Off** (turn it on in Edit agent). See [Web chat](guides-agents-web-chat.md).
- A banner appears when the YAML file was edited into an invalid state; the last valid revision stays in use.

Tabs:

| Tab | Shows |
|-----|-------|
| **Sessions** | This agent's sessions, with filters (status: Open, Running, Waiting on you, Held, ...; source) and stats: active runs, sessions this week, run success rate, estimated cost |
| **Configuration** | The current definition, read-only |

## Edit (`#/agents/<id>/edit`)

The definition form with a tool checklist (builtin groups, MCP servers and their tools, skills, Stageflow tools), approvals, limits, channel and schedule, web chat and observability. Saving shows a **diff review** against the current revision and **version history** (every save is a revision; restore an older one). **⌘S** saves. A stale edit is refused as `agent.conflict`. **Remove** archives the agent (`agents/<id>.agent.yaml` leaves the project; history stays readable).

## Sessions

- **Agent sessions** (`#/agent-sessions`) lists every agent's sessions with search and filters; the rail badge counts sessions in flight. `#/agents/sessions` opens the same page.
- **A session** (`#/agents/<id>/sessions/<sessionId>`) is the conversation, with a composer to message the agent as an operator, the turns, any pending approval (**Approve** / **Deny**), delivery state for channel replies, and **Stop**.

## Run inspector (`#/agents/<id>/sessions/<sessionId>/runs/<runId>`)

One turn of a session in five tabs:

| Tab | Shows |
|-----|-------|
| **Steps** | The run as a readable story, with Approve and Deny on a pending approval |
| **Waterfall** | Spans on a timeline, with the span filter and a detail panel |
| **Messages** | The messages in the turn |
| **Logs** | Built from spans, approvals and errors (no log records are stored) |
| **Configuration** | The revision the run used |

Spans and capture modes: [Agent observability](agent-observability.md).

## Approvals

A pending approval appears in three places: the [Inbox](console-inbox.md#answering-an-agent-approval) (and the desktop notification, see [Settings](console-settings.md#notifications)), the session page and the run inspector. The same decision is also available through the [REST API, CLI and MCP](agent-api.md).
