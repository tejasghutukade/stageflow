---
layout: default
title: Console - Inbox
---

# Inbox

`#/inbox` is the console's home page. It lists everything that waits on you: **pipeline gates** (HITL questions from a stage) and **agent approvals** (an agent wants to use an ask-first tool). The rail badge counts both.

## Tabs

| Tab | Route | What it lists |
|-----|-------|---------------|
| **Needs you** | `#/inbox` | Pipeline gates and agent approvals, oldest first. Below the queue: failed and running runs that are not waiting on you |
| **Failed** | `#/inbox?tab=failed` | Runs with a failed stage, with a likely-fix hint and **Retry stage** |
| **Done today** | `#/inbox?tab=done_today` | Runs that finished today |

When nothing waits, an empty state shows and offers **G** to go to Pipeline runs. It also shows whether desktop notifications are on (see [Settings → Notifications](console-settings.md#notifications)).

## Answering a pipeline gate

Select a gate in the queue. The right pane shows the question, the stage output and a note field. **Accept** (**1**), **Reject** (**3**, when the gate allows it) and **N** to focus the note. **O** opens the run. The same answer panel is on the run page; see [HITL](hitl.md) for the gate kinds and what each answer does.

## Answering an agent approval

An agent approval appears in **Needs you** when an agent session pauses on a tool in its `approvals.ask_first` list, or on any `bash` call (always ask-first). The pane shows the agent, the tool and what it will run.

- **Approve and run** (**1**) lets that one call proceed. An identical call in the same session is not asked again.
- **Deny** (**3**) tells the agent to continue without it.
- **Open session** (**O**) opens the agent session page.

Approvals expire after the agent's `timeout_minutes`. Only an operator at the console, the CLI or MCP can decide here; the agent's `approvals.approvers` setting decides who may. See [Agents](agents.md#console-api-cli-mcp).

## Keyboard

| Keys | Action |
|------|--------|
| **J / K** | Move in the queue |
| **1** / **3** | Approve or Accept / Deny or Reject the selected item |
| **N** | Focus the note (pipeline gates) |
| **O** | Open the run or agent session |
| **R** | Retry the failed stage (Failed tab) |
| **G** | Go to Pipeline runs (when Needs you is empty) |

All shortcuts: [Operator console](operator-console.md#keyboard-shortcuts).

## Desktop notifications

With **Settings → Notifications** on, the console sends a desktop notification when a stage starts waiting on you ("Stage waiting on you") and when an agent asks for approval ("Agent waiting on you"). They are sent by the page, so the console must be open in a browser tab. A page load never notifies for items that were already waiting.
