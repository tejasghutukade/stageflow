import type { GuideKnowledgeTopic } from "../index.js";

export const overviewTopic: GuideKnowledgeTopic = {
  id: "overview",
  title: "Building blocks and which one to pick",
  summary:
    "What pipelines, stages, tasks, agents, triggers, connections, memories, MCP, skills and evals are, how they relate, and how to choose between them.",
  body: `# Building blocks and which one to pick

Stageflow runs configurable multi-stage workflows and project agents, with a local console. Work can be anything repeated: releases, research, content review, operations runbooks, support, software changes. Nothing in the product is tied to one domain.

## The pieces

- **Pipeline** (\`*.pipeline.yaml\`). An ordered graph of stages. Each stage runs in a fresh agent session, does one job and hands a typed result (an envelope) to the next stage. Wiring is declared on the source stage with \`route\`.
- **Stage**. One step of a pipeline: a system prompt, a model, a required input and output schema (\`io\`), and optional checks (\`verify\`), questions to a person (\`gate_kinds\`), tools (MCP, skill, browser), a send channel and secrets. A stage can live inline in the pipeline file or in its own YAML file referenced with \`uses:\`.
- **Task** (\`*.task.yaml\`). The input a pipeline run starts from: \`id\`, \`goal\`, optional \`context\`, \`constraints\`, \`input\` (structured data for the entry stage) and an optional working folder or repository. A run is always one pipeline plus one task.
- **Run**. One execution of a pipeline with a task. Runs are stored on the Host under \`$STAGEFLOW_HOME\` (default \`~/.stageflow/\`), not in the project.
- **Agent** (\`agents/<id>.agent.yaml\`). A configured assistant that holds a conversation over many turns: instructions, a model, the tools it may use, ask-first approvals, limits, and how people reach it (console, public web chat page, one inbound channel, or a schedule).
- **Trigger** (\`*.trigger.yaml\`). Starts a pipeline run without someone clicking. Kinds: \`manual\` (fired on request), \`schedule\` (cron), \`event\` (GitHub pull requests, a signed webhook, or an IMAP mailbox).
- **Connection**. A host-level link to a messaging provider (AgentMail, Slack, Telegram, iMessage via Photon, WhatsApp via Photon). A stage uses it to send one message to a recipient fixed in YAML. An agent can also answer on it.
- **Memory**. A named store on the Host with a cover page and keyed cards. Attached to a whole pipeline (every stage gets it) or to an agent. Sessions read and write it with memory tools.
- **MCP servers and skills**. Extra tools for a stage or an agent: MCP servers from the project \`.mcp.json\` or saved in the console, and installed skills.
- **Eval** (\`evals/<id>.eval.yaml\`) with a **dataset**. Runs one stage or one agent over many cases, grades each output, repeats each case, and compares runs.

## How they relate

A trigger points at a pipeline and (usually) a task. The pipeline's stages may list MCP servers, a skill, a browser profile, one channel and secrets. The pipeline may attach memories. An eval points at one stage or one agent plus a dataset. An agent may list MCP tools, skills, Stageflow tools, sub-agents, memories and one connection.

## Which one to pick

**Pipeline vs agent**
- Pick a **pipeline** when the work has known steps in a fixed order, each step can be described with an input and an output, and you want checks between steps. Runs are repeatable and inspectable stage by stage.
- Pick an **agent** when someone needs to talk back and forth, the next step depends on the conversation, or people should reach it by chat, email, Slack, Telegram, iMessage or a web page.
- An agent can start pipeline runs if it is granted the \`runs.control\` tool group (\`start_run\`), so a conversational front end can hand fixed work to a pipeline.

**One stage vs many stages**
- Start with a one-stage pipeline when the job is a single step. Split into stages when a step has its own clear output, needs a different model or tools, needs a person to approve before continuing, or should be checked on its own.
- Many small stages cost more model sessions; one huge stage is hard to check and to recover.

**Task vs trigger**
- A **task** is what to do. A **trigger** is when to do it. You always need a pipeline; you need a catalog task for anything started from the console's Start a run, for a manual trigger fired from the console, and for a schedule trigger.
- A trigger without a task (dynamic mode) only works when whoever fires it supplies the task: GitHub, webhook and email adapters build one from the event, or a manual fire passes one inline.

**Memory vs task context**
- Put facts for one run in the task (\`context\`, \`constraints\`, \`input\`).
- Use a **memory** when facts must survive across runs or conversations and be updated by the sessions themselves (a contact list, per-ticket notes, what was already sent).

**Connection vs MCP**
- Use a **connection** when a stage should notify someone and the recipient must be fixed. The agent cannot change the recipient.
- Use an **MCP server** when the stage or agent must read or act in another system (an issue tracker, docs, a database).

**Eval**
- Add an eval when a wrong answer is costly or you are about to change a prompt, model or tools and want to know if it got better or worse.

## Who can do what

Guide and other agents can create and edit almost everything with tools. Only a person can answer a pipeline gate, decide a feedback loop at its limit, or approve or deny an agent's ask-first action (tool group \`gates.decide\` is operator-only).
`,
};
