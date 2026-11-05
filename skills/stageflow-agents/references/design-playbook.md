# Design playbook

How to turn a request into one agent file: what to ask, when to stop asking, and how to choose the settings the validator does not choose for you. Field types and ranges are in [agent-definition.md](agent-definition.md).

## Contents

- [Interview](#interview)
- [Agent or pipeline](#agent-or-pipeline)
- [Writing instructions](#writing-instructions)
- [Model](#model)
- [Thinking](#thinking)
- [Limits](#limits)
- [Capture](#capture)

## Interview

One decision per turn. The two or three questions in that turn all serve that decision. A later decision waits until this one has an answer. Draft the file only after the user confirms the job.

### Rules to follow

These are the Agent Author's rules. Follow them. Where the console author calls `update_agent_draft`, you write `agents/<id>.agent.yaml` instead. The confirm-before-draft rule is the same.

How you talk:

> Short turns, plain words, present tense.
>
> Two or three questions a turn. Do not dump a questionnaire.
>
> Do not narrate tool names.

Understand the job first:

> A first message is a starting point, not a spec. Your job is to understand the use case before you fill the config.
>
> Do not call update_agent_draft while the brief is still thin. Asking questions is a complete turn.
>
> Use what they already said. Ask only what would change the draft.
>
> When you can describe the job in two or three sentences, say that summary and ask them to confirm or correct it. Do not draft before they confirm, unless they tell you to go ahead anyway.
>
> When the brief is thin, offer one concrete agent: a name, what it will do, what it will not do, and which tools. When they accept that suggestion, call update_agent_draft in that same turn. Do not wait for another question.

When an answer is vague, confused, or contradicts an earlier one:

> Restate what you heard in one sentence. Offer one concrete suggestion they can accept or correct (a name, a boundary, a tool grant, or a refusal). Ask which part is wrong.

When they say "just build it" before the brief is solid:

> State the assumptions in one or two sentences. Offer the narrowest useful version. Draft only after they accept those assumptions, or if they insist a second time. Name every assumption in the reply after you draft.

When you draft:

> instructions must describe this job: who it serves, how it decides, what it refuses, and what a good reply contains. Do not write a generic "be helpful" prompt.
>
> Grant only the tools the job needs. A new agent stays sealed: read only, until the job needs write or shell.
>
> Anything that sends, posts, writes, merges, or deletes goes in approvals.ask_first.
>
> Leave model.id unset unless they name a model, and say you did that.
>
> Capture stays metadata unless they ask for full content.
>
> Do not set tools.browser. Do not invent a connection id, MCP server, or skill name.

Learn these, in whatever order the gaps are. Skip a row that is already answered.

| Decision | Learn |
|---|---|
| Who and where | Who uses it, and in what situation (a person in chat, a schedule, a channel) |
| Result | What a good result looks like, and what a bad one looks like |
| Reach of the tools | What it may read, and what it may change. What it must never do without asking |
| Source of truth | Where the facts live. Read only the project's own documentation: `docs/`, `policies/`, `AGENTS.md`, and `README.md` (`.md` and `.txt`). If they point at source code, say you only read documentation for this interview and ask which doc describes the behavior |
| How people reach it | Console, a public web link, signed-in customers, email, Slack, Telegram, iMessage, a schedule, or another agent |

After they confirm the two-or-three-sentence summary, write the file in that same turn. Show the YAML. Name anything they asked for that you left off because `list_connections`, `list_project_mcp`, `sf skills list`, `list_memories`, or `sf agents list` did not return it.

## Agent or pipeline

Pick an agent when the work is a conversation: the next step depends on what the person just said, or people reach it by chat, email, Slack, Telegram, iMessage, or a web link.

Pick a pipeline (the `stageflow-pipelines` skill) when the work is a fixed sequence of steps. A sequence that should run on a timetable is a pipeline with a schedule trigger. An agent `schedule` starts a fresh chat session; it does not run a graph, and it has no typed check between steps.

An agent can start pipeline runs when it is granted the Stageflow group `runs.control`. Put `stageflow.start_run` in `approvals.ask_first`. Stageflow's A2A server publishes pipelines only. To offer this job to outside agents, build the pipeline and publish that.

If they insist on an agent for a fixed sequence, and it is possible and safe, build the agent and stop. Leave it disabled until they say to enable it.

## Writing instructions

`instructions` is the system prompt. Write it for this job only. Four parts, in this order:

1. Who it serves, and the situation it is in.
2. How it decides: what it looks up first, and what it does when the source does not answer.
3. What it refuses, in concrete cases (refunds, file changes, other people's data), not a slogan.
4. What a good reply contains: length, shape, and the evidence it must include.

Use a YAML block scalar (`|`). Name the tools by the names the model sees (`helpdesk_search_articles`, `stageflow_list_runs`, `agent_<id>`), and say which of those wait for a person. The grant ids in `approvals.ask_first` use dots and colons; those ids are for the file, not for the prompt. See [tools-and-approvals.md](tools-and-approvals.md).

Closest shapes to copy: `assets/examples/research_helper.agent.yaml`, `support_inbox.agent.yaml`, `morning_digest.agent.yaml`, `public_faq.agent.yaml`.

## Model

Leave `model.id` unset unless the user names a `provider/model`. Tell them you left it unset, so the project default model is used. Keep `model.backend` unset (`pi`). `claude` saves with warning `agent.backend_unavailable` and every session fails.

An id no connected provider lists only warns `agent.model_unknown` and is still tried. Cursor models (`cursor/…`) warn `agent.model_native_tools` and sessions fail unless the Host sets `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1`, because that provider runs its own file and shell tools and the grants cannot hold. Do not choose a Cursor model to work around a grant.

Check connected providers with `sf providers status` before you name one.

## Thinking

`model.thinking` is `off`, `low`, `medium` (the default), or `high`.

| Situation | Set |
|---|---|
| Short answers from a fixed fact list (a public FAQ) | `low` |
| Ordinary lookup and a written reply | leave unset (`medium`) |
| The user asked for deeper reasoning and accepted the extra tokens | `high` |
| The user asked to spend as little as possible on a mechanical reply | `off` |

Say which you chose when it is not the default.

## Limits

A limit is checked when a turn starts. A turn already running is not cut short. A new turn past a limit is refused with `agent.limit_reached` (`web_chat.limit_reached` on web chat).

| Field | Default | Use |
|---|---|---|
| `session_minutes` | `10` (1–1440) | How old the session may be before the next turn is refused |
| `max_turns` | `40` (1–1000) | How many turns the session may have |
| `cost_usd` | unset, no cap | A number greater than 0. With `always_on`, the cap is the last 24 hours |
| `long_context` | `summarize` | When rebuilt history exceeds 60,000 characters: a one-line digest of the dropped messages, or `truncate` to drop them |
| `always_on` | `false` | The session does not end by time or turns, and an iMessage turn interrupted by a Host restart is resumed. Set this for iMessage |

Anything a person outside the team can reach (web chat, or a channel) gets all three of `limits.cost_usd`, `max_turns`, and `session_minutes`. A scheduled agent gets a small `max_turns` and a `cost_usd` cap, because nobody is in the thread to stop it.

`approvals.timeout_minutes` defaults to 30 (1–10080). `on_timeout: skip` tells the model the action was skipped and lets it continue. `on_timeout: deny` ends the turn with `agent.approval_expired`. Use `deny` when a skipped send or write would be worse than silence. A channel or schedule that uses `ask_first` waits for a person every time; say that in the summary before you write it.

## Capture

`observability.capture` defaults to `metadata`. Leave it there unless the user asks for full content.

| Value | What is stored |
|---|---|
| `metadata` | Span timing and tool names. Prompt, reply, and tool bodies are not stored |
| `full` | Prompt, reply, tool arguments, and tool results, after secret redaction. Use only when they asked, and not for personal or confidential content |
| `off` | No spans |

`observability.otlp: true` pushes each finished turn to the collector in `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` on the Host. With neither variable set, the flag does nothing. Export of one session is REST only: `GET /api/agents/<id>/sessions/<sessionId>/otlp`.

`evals.groundedness: true` scores tool-using replies with one extra model call per turn, on the same model. Leave it off unless they asked to pay for that score. Measuring the agent properly is the `stageflow-evals` skill.
