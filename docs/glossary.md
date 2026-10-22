# Glossary

Terms that are easy to mix up.

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| **Pipeline** | A DAG of stages defined in `*.pipeline.yaml` | An agent |
| **Run** / **Pipeline run** | One execution of a pipeline. Listed on the **Pipeline runs** page | An agent session or agent run |
| **Stage** | One step of a pipeline, executed by a model | An agent |
| **Agent** | A project-owned conversational definition in `agents/<id>.agent.yaml` that answers people over time. See [Agents](agents.md) | The stage `agent:` field (below) |
| **Agent backend** | The stage field `agent: pi \| claude` and the agent `model.backend` that choose which model runtime executes | An Agent |
| **Agent session** | A conversation with an agent (many turns). Listed under **Agent sessions** | A pipeline run |
| **Turn** | One message in and one reply out within a session | A stage |
| **Agent run** | The run inspector's view of one turn: steps, waterfall, messages, logs, configuration | A pipeline run |
| **Revision** | A saved version of an agent definition (`v3`). Sessions are pinned to the revision they started on | A git commit |
| **Approval** | A paused ask-first tool call waiting for a person | A pipeline gate |
| **Gate** | A pipeline stage waiting for a human answer ([HITL](hitl.md)) | An agent approval |
| **Inbox** | The console's "Needs you" page: gates and agent approvals | Email |
| **Connection** | A named external service for channels (AgentMail, Slack, Telegram, iMessage, WhatsApp) in `connections.yaml`. Agents answer on one; stages send on one | An email account, an MCP server |
| **Channel** | The use of a connection by a stage (`channels:`) or an agent (`channel:`) | A connection |
| **Email account** | An IMAP/SMTP mailbox in `email.yaml`, used by email triggers | An AgentMail connection |
| **Web chat** | The public `/chat/<slug>` page for an agent | The Workshop chat |
| **Workshop** | The console's pipeline-authoring chat | Web chat |
| **MCP server (Settings)** | The Stageflow MCP endpoint other tools use to drive Stageflow (Settings → MCP server) | Project MCP |
| **Project MCP** | Tool servers (from `.mcp.json` or saved in the console) that agents and stages can use | The Stageflow MCP endpoint |
| **Check** | A probe that starts a Project MCP server in isolation and lists its tools | A connection **Check now** (a live provider check) |
| **Console secret** | A write-only value saved in Settings → Project MCP that fills `${NAME}` in MCP servers | A stage `secrets:` entry from the Host environment |
| **Grant** | A tool an agent may call (`tools:`), enforced on every call | An approval |
| **Ask first** | A grant that needs a person's approval each time the call is new in a session | A block |
| **Eval** | The file `evals/<id>.eval.yaml` that names one stage or one agent, a dataset, graders and run defaults. See [Evals](evals.md) | An eval run, or an agent's `evals:` groundedness setting ([Agent observability](agent-observability.md)) |
| **Dataset** | A file of cases (`datasets/<name>.dataset.jsonl`, `.json` or `.csv`) | A task input |
| **Case** | One test input in a dataset: `id`, `input`, optional `expected`, `tags`. For an agent eval it is a **scenario** | A result |
| **Repeat** | One execution of a case. Each case runs `repeats` times because models vary | A retry of a failed stage |
| **Result** | One (case, repeat): the stage output and its grades | A pipeline run result |
| **Grader** | One rule that scores a result: `schema`, `field`, `reference`, `rubric` or `code`; for agents also `tool_calls`, `conversation_check` or `goal_reached`. Its verdict on one result is a **grade** | A gate or a `verify` check |
| **Rubric** | A grader written in words and judged by a model | A rubric for human reviewers |
| **Judge** | The model that applies rubric graders (`anthropic`, `openai` or `openrouter` models) | The stage's own model |
| **Eval run** | One execution of an eval: all results, grades, statistics, cost and a config snapshot (`er_…` ids, `Run #n`) | A pipeline run. The stage runs it starts are marked `origin = eval` and hidden from the Runs list |
| **Scenario** | The `input` of a dataset case when an eval targets an agent: a list of user messages (`script`) or a persona, goal and opening (`simulated`), plus optional facts and tool mocks. See [Evals for agents](evals.md#scenarios-and-datasets) | A pipeline task |
| **Driver** | What plays the user in an agent eval: a script of fixed messages, or the simulator | A pipeline driver or a model backend |
| **Simulator** | The model that plays the user in a `simulated` scenario (`defaults.user_model`, default the judge) | The judge, which grades; or the agent under test |
| **Conversation subject** | What agent-eval graders read: the messages, recorded tool calls, final reply, turns, stop reason and usage of one conversation | A stage's envelope |
| **Tool policy** | How an agent eval treats tool calls: `read_only` (default; write, shell and unlisted tools are stubbed and recorded), `mocked` or `real` (needs explicit consent). See [Evals for agents](evals.md#tool-policy) | An agent's grants or its ask-first list |
| **Eval session** | The hidden agent session an agent eval opens for each conversation. See [Evals for agents](evals.md#eval-sessions) | A session a person started |
| **Config snapshot** | Everything that determined an eval run, stored with it and never edited | The eval file, which can change later |
| **Fingerprint** | The first 8 hex characters of a hash of the config snapshot. Equal fingerprints mean the same setup | A git commit |
