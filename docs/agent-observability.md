# Agent observability

What an agent run records, how much of it, where you see it, and how to send it elsewhere. For the settings themselves see [Agent definition](agent-definition.md#guardrails-evals-observability); for what happens during a turn see [Agent runtime](agent-runtime.md).

## What is recorded

Every turn records a **span tree** in the run store database. The root is `invoke_agent <agent id>` (kind `agent`); its children are:

| Span name | Kind | One per | Notable attributes |
|-----------|------|---------|--------------------|
| `chat` | `model` | model call | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.cost_usd`, input and output tokens |
| `execute_tool <tool id>` | `tool` | tool call | `gen_ai.tool.name`; status `error` when the tool failed |
| `invoke_agent <callee id>` | `sub_agent` | sub-agent call | `gen_ai.tool.name` (`agent:<id>`) |
| `approval <tool id>` | `gate` | ask-first pause | `stageflow.approval.outcome` (`approved`, `denied`, `expired`, `aborted`) |
| `guardrail` | `guardrail` | blocked reply | `stageflow.guardrail.pattern` |
| `eval groundedness` | `guardrail` | scored reply | `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value` |

The root also carries `gen_ai.agent.name`, `stageflow.agent.revision` and, when the definition sets a model, `gen_ai.request.model`. A turn that failed before any child ran has a root with `error.type` set to the error code. Span names and attributes follow the OpenTelemetry GenAI conventions where one exists.

Each turn has a 32-character trace id, shown on the run page, and each span has its start, end, duration and status (`ok`, `error`, `cancelled`).

Tokens and cost are summed per turn (`agent_turns`) and shown per session and per agent.

## Capture modes

`observability.capture` decides how much content is kept:

| Mode | Spans | Prompt, argument and result text |
|------|-------|----------------------------------|
| `off` | **None.** No span is stored, so there is no timeline, nothing to export and nothing to push live. Turns, messages, approvals, tokens and cost are still stored. | No |
| `metadata` (default) | Yes: names, timings, status, tokens, attributes. | No |
| `full` | Yes. | Yes: the user message and reply on the root, tool arguments and results on tool spans, after secret redaction. |

`chat` spans never carry text, whatever the mode.

### Redaction

Text is redacted **before it is stored** (secret-shaped strings and any named secret the Host knows are replaced), and again when a trace is exported, so a later change to storage cannot leak through export. Redaction removes known secret shapes; it does not understand your data. If an agent handles personal or confidential content, keep `metadata`.

## Eval sessions {#eval-sessions}

When an [agent eval](evals.md#evals-for-agents) runs, each conversation is an agent session marked as an eval session. Eval sessions are recorded like any other (messages, turns, spans, tokens, cost) with two differences: capture is forced to `full` so graders and the transcript can see tool arguments and results, and OTLP push and the groundedness judge are off. They are **hidden** from the agent's session list, the **Agent sessions** page, the Inbox, approval counts and statistics, so they never mix with real use.

You can still open one by its id. In the console the eval result's **Transcript** tab links to the **Agent run** page, which shows the usual steps and waterfall for that conversation. Deleting the eval run deletes its eval sessions; a crashed run's leftovers are removed when the Host next starts, once they are 7 days old and no result refers to them.

## Where you see it

- **Agent session** page: the messages, turns, cost and tokens of one session, and the average of its eval scores.
- **Agent run** page (one turn), with five tabs:

  | Tab | Shows |
  |-----|-------|
  | Steps | The run as a readable story, with **Approve** and **Deny** when it waits. |
  | Waterfall | Spans on a timeline, with a span filter and a detail panel. |
  | Messages | The message that started this run and the agent's reply. |
  | Logs | Records built from spans, approvals and errors. No separate log records are stored. |
  | Configuration | The revision the run used. |

  The header shows duration (working and waiting time), span count, model calls, tool calls, tokens, estimated cost and the eval score. When capture is not `full`, the span panel says only metadata was recorded.
- **Agent sessions** in the rail: sessions across all agents, filterable. An agent's own page lists only its sessions.

## Groundedness

`evals.groundedness: true` scores how well a reply is supported by what the tools returned, from 0 (unsupported or contradicted) to 1 (fully supported).

- It runs after the turn has produced its reply, using the **same model** as the agent with no tools. Each tool output is cut to 4,000 characters and the reply to 8,000 before they are judged.
- It is skipped when the reply used no tools, the reply is empty, or the turn was stopped or ended in a failure. A judge that fails or returns no number records nothing; it never fails the turn.
- The score is stored per turn, shown in the run header, averaged on the session page, and recorded as an `eval groundedness` span (unless capture is `off`). The judge is one more model call, so it adds a little time and cost to a turn that used tools.

## Export

- **One session as a file.** The run page's **Export OTLP** button downloads the session's traces as OTLP/JSON (`<session id>.otlp.json`); the same file is `GET /api/agents/<id>/sessions/<session id>/otlp`.
- **Live push.** With `observability.otlp: true`, the Host posts each finished turn to a collector. The collector comes from the Host's environment:

  | Variable | Effect |
  |----------|--------|
  | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The full traces URL. Wins over the next one. |
  | `OTEL_EXPORTER_OTLP_ENDPOINT` | A base URL; `/v1/traces` is added. |
  | `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `name=value` pairs sent with each request (for an API key). |

  With none of the endpoint variables set, `otlp: true` does nothing. Each push is JSON over HTTP with a 10-second timeout and is sent in the background: a collector that is down or slow never fails or delays a turn; the error is logged and the turn is not retried. Nothing is pushed when capture is `off`. Pushes happen for failed and blocked turns too.

The export is an OTLP `ExportTraceServiceRequest` with the resource `service.name = stageflow-agent-runtime` and `gen_ai.agent.name`, and the scope `stageflow.agents`. Spans keep their ids, so the trace id and parent links survive. Text appears as `gen_ai.input.messages` and `gen_ai.output.messages`.
