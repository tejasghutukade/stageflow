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
| **Memory** | A host folder (`memories/<id>/`): `memory.yaml` version 1, a cover page (`body.md`), and cards beside it. A pipeline or an agent stores the memory id and, on Pi, can read and replace the cover and add, update, read, and search cards | A card key, a run artifact, a session transcript |
| **Memory card** | A keyed note in a memory. The key is the subject's own id (an email, a ticket id, a version, or a path), 1–1024 characters after trim. A Pi stage or agent session can add, update, read, and search it. The operator can correct it or delete it | The memory id, the cover page |
| **Email account** | An IMAP/SMTP mailbox in `email.yaml`, used by email triggers | An AgentMail connection |
| **Web chat** | The public `/chat/<slug>` page for an agent | The Workshop chat |
| **Workshop** | The console's pipeline-authoring chat | Web chat |
| **MCP server (Settings)** | The Stageflow MCP endpoint other tools use to drive Stageflow (Settings → MCP server) | Project MCP |
| **Project MCP** | Tool servers (from `.mcp.json` or saved in the console) that agents and stages can use | The Stageflow MCP endpoint |
| **Check** | A probe that starts a Project MCP server in isolation and lists its tools | A connection **Check now** (a live provider check) |
| **Console secret** | A write-only value saved in Settings → Project MCP that fills `${NAME}` in MCP servers | A stage `secrets:` entry from the Host environment |
| **Grant** | A tool an agent may call (`tools:`), enforced on every call | An approval |
| **Ask first** | A grant that needs a person's approval each time the call is new in a session | A block |
