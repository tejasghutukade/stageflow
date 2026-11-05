# Concepts

Stageflow runs a pipeline of stages. A person writes YAML. Each stage is one fresh agent session. Stages hand off a typed envelope. A gate pauses for a person. The same pipeline runs on a laptop, in CI, and through MCP. The domain is yours: a release, a research digest, a review, an ops runbook, or a software change are all ordinary pipelines.

Use this file to tell two similar words apart. Authoring rules live in the `stageflow-pipelines` skill. Project agents live in `stageflow-agents`. Running and answering live in `stageflow-operate`. Measuring quality lives in `stageflow-evals`.

## Contents

- How a run is put together
- Words that get confused
- Glossary

## How a run is put together

A **catalog** is the set of YAML files a project declares in `stageflow.yaml`. A **task** says what this run is for. A **pipeline** lists the stages and how they connect. The **Host** loads that catalog, starts a **run**, and gives each **stage** a new **session**. The stage reads the incoming **envelope**, does its work, writes **artifacts**, and emits the next envelope. A **gate** parks the stage until a person answers. The run stays `running`. When the last stage finishes, the run is succeeded, failed, or cancelled.

Nothing in that chain is specific to software delivery. The YAML describes the work. Stageflow checks that the files are shaped correctly and wired together.

## Words that get confused

**Stage and project agent.** A stage runs once, inside one run, then ends. A project agent is a named assistant that holds conversations across many turns. It is not a step in a pipeline. Creating one is the `stageflow-agents` skill. `agent: pi` or `agent: claude` on a pipeline is the executor for stages, not a project agent.

**Session and run.** A run is one execution of a pipeline (or one agent conversation, when you are talking about agents). A stage session is the agent process for a single stage attempt. It is always new. Retry opens another attempt. Resume continues the interrupted one. An agent session is the transcript of a chat with a project agent. Eval sessions are agent sessions the eval runner opens. They are hidden from the normal session list.

**Envelope and artifact.** The envelope is the structured handoff between stages: status and a payload that must match the stage's output schema. An artifact is a file the stage wrote that a later stage or a person can read. The envelope can point at an artifact. The artifact is not the envelope.

**Gate and approval.** A gate is a pause inside a pipeline run (human in the loop). An approval is a project agent asking to use a tool. They are different queues. Answering a gate is `stageflow-operate`. Answering a pending agent approval is `stageflow-operate`. Editing `approvals.ask_first` on the agent file is `stageflow-agents`.

**Connection and channel.** A connection is a Host-level account (Slack, email, and the other send providers): identity and secrets, stored outside YAML. A channel is a stage or an agent using one connection to send. Recipients are pinned in YAML. The agent does not pick them. Secrets never go in the pipeline file. A stage has at most one channel.

**Trigger and run.** A trigger is a catalog file that starts a pipeline without you typing `sf run`. Kinds are `manual`, `schedule`, and `event`. Event sources include a webhook, GitHub, and email. Firing a trigger creates a run. The trigger is not the run.

**A2A and MCP.** MCP is how this harness calls the Host (`/mcp`). A2A is how an outside caller invokes a published pipeline with its own token. Publishing, callers, and the agent card are Host configuration. They are not pipeline YAML keys you invent.

**Eval and validate.** `sf validate` checks files. It is free and does not call a model. An eval runs a stage or an agent against a dataset and grades the outputs. That costs money. The `stageflow-evals` skill owns it.

**Host and catalog.** The Host is the running process (`sf ui` or `sf mcp`) and the global store under `$STAGEFLOW_HOME`. The catalog is files in the project. The Host remembers runs. The catalog remembers how the next run should behave. Deleting a pipeline file does not delete past runs.

**Model and agent.** `model` is `provider/model` (for example `openrouter/auto`). `agent` is `pi` or `claude`. You can set both. Unset `model` is a load error. Unset `agent` means Pi.

## Glossary

| Term | Meaning |
|---|---|
| Catalog | Pipelines, stages, tasks, triggers, evals, and datasets the manifest lists. Filename patterns default to `*.pipeline.yaml`, `*.task.yaml`, `*.trigger.yaml`, `*.eval.yaml`, and the dataset suffixes. |
| Manifest | `stageflow.yaml` at the project root. `version: 1`. Declares catalog directories and an optional default `model` and `agent`. |
| Pipeline | Ordered stages, plus the wiring between them (routes, loops, gates). One file, usually `*.pipeline.yaml`. |
| Stage | One unit of work. Runs in a fresh agent session. Declares `io` (input and output schemas), a prompt, and usually a `model`. May live in its own file and be pulled in with `uses`. |
| Task | The input to a run: an id, a goal, and optional structured input. A pipeline without a task has nothing to do. |
| Envelope | The typed message a stage emits for the next stage. The shape is the stage's output contract. |
| Artifact | A file produced during a run, stored with the run, readable later with `sf artifact` or the MCP tool `read_artifact`. |
| Gate | A human checkpoint. The run stays `running`. The stage is `waiting_for_input`. `sf run` exits 2. There is no run status `waiting`. |
| Run | One execution: a task plus a pipeline, with stage attempts and cost. Status is `created`, `queued`, `running`, `succeeded`, `failed`, or `cancelled`. A parked gate leaves the run `running`. |
| Attempt | One try of one stage inside a run. Retry creates another attempt. Resume keeps the session. |
| Agent (project) | A saved conversational assistant: instructions, tools, model, optional channel and schedule. Not a pipeline stage. |
| Agent (executor) | `pi` or `claude` on the manifest or pipeline. Selects the stage backend. |
| Session | A stage's agent conversation, or a project agent's chat. Stage sessions are not reused across stages. |
| Connection | Host-level credentials for a send provider. Created in the console or with MCP `create_connection`. Never a YAML secret. |
| Channel | One send path on a stage or a project agent, bound to a connection, with the recipient fixed in the definition. |
| Trigger | Catalog entry that starts a pipeline on a schedule, an external event, or a manual fire. |
| A2A | Agent-to-agent HTTP on the Host. Callers have their own tokens. Publications choose what an outside caller may invoke. |
| Eval | A measured trial of one stage or one project agent over a dataset. Separate files (`*.eval.yaml`, dataset files). Costs money to run. |
| Host | `sf ui` (console plus API) or `sf mcp` (API only). Serves `/mcp`, `/livez`, `/readyz`, and `/api/*`. Holds the run store. |
| Console | The browser UI on the Host URL. Only `sf ui` serves it. |
| MCP | Streamable HTTP at `<host>/mcp`. The tool surface for a harness. Requires a drive token when tokens are configured. |
| Provider | A model vendor (Anthropic, OpenAI, OpenRouter, Cursor, and others Pi knows). Login is `sf providers`. |
| Control token | Bearer secret for the Host. Drive token starts and mutates. Read token only reads `/api/*`. |
| Checkout | The working tree a run is allowed to edit. Distinct from the catalog that defined the run. |
