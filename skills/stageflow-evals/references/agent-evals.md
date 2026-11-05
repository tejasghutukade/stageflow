# Agent evals

What changes when the target is a project agent: conversations instead of single outputs, the tool and approval policies, consent for real tools, cost and privacy. Read this before writing or running any eval with `target.kind: agent`.

## Contents

- What an agent eval is
- Script or simulated
- The conversation block
- Tool policy
- Approval policy
- Real tools and consent
- Always blocked
- Eval sessions are hidden
- Limits, cost and revision
- A worked eval with tools, mocks and approvals
- Failure statuses on a result
- Privacy statement
- Making a good agent eval

## What an agent eval is

The target is `target: { kind: agent, agent: <id> }`, an agent in the project's `agents/` directory. A case is a scenario. Stageflow plays the user, opens an eval session with the agent, records the whole conversation (messages, tool calls with outcomes, final reply, turns, why it stopped, usage) and grades it. The agent's own definition, tools and instructions are used as they are; nothing in the agent file is edited.

Use it to check, before saving a change to an agent's instructions, model or tools, that it still answers from its instructions, asks a clarifying question when it should, declines what it should decline, calls the right tools and never calls the wrong ones.

A hand-written agent file defaults to disabled. Evals run a disabled agent anyway and only warn (`eval.agent_disabled`); add `enabled: true` to the agent to silence it (that also makes the agent chat-able). An archived agent is an error. If the agent does not exist yet, create it first (use the `stageflow-agents` skill).

## Script or simulated

| | Script | Simulated |
|---|---|---|
| Who plays the user | Fixed messages in `input.script` | A model, from `persona`, `goal`, `facts`, after your `opening` |
| Cost | The agent's turns | Agent turns plus a simulator call per turn after the opening, usually plus a judge |
| Repeatability | High; only the agent varies | Lower; both sides vary, two repeats can be different conversations |
| Best for | Regression checks, rule graders, tool behavior | Persistence, pushback, vague or emotional users, multi-step goals |

Start with script scenarios and rule graders (`tool_calls`, `conversation_check`, `reference`). They are free of judge cost and repeatable. Add simulated scenarios with `goal_reached` for what a script cannot reach. Simulated cases need a simulator model: `defaults.user_model`, falling back to `defaults.judge`, from `anthropic`, `openai` or `openrouter`; a missing one is `eval.user_model_missing`, another provider is `eval.simulator_unsupported`. A simulator equal to the agent's own model warns (`eval.simulator_same_as_agent`).

A scenario's `input.mode` overrides `conversation.mode`, so one dataset can mix both. Keep script and simulated scenarios in separate evals when you want to run the cheap one often: two files, two datasets (`assets/examples/agent-eval/` has both).

## The conversation block

```yaml
conversation:
  mode: script
  max_turns: 4
  turn_timeout_ms: 120000
  tools: read_only
  approvals: record_only
  read_only_tools: [billing.lookup_invoice]
```

Omit it for script mode, 8 turns, `read_only`, `record_only`. Keys and ranges are in `eval-file-reference.md`. `max_turns` ends a scenario normally; it is not a failure.

## Tool policy

`conversation.tools` decides what a tool call does. Every call is recorded in the conversation whatever happens to it, with its `policy_outcome`.

| `tools` | Read-class tools | Every other tool |
|---|---|---|
| `read_only` (default) | Run | Stubbed, or mocked if the scenario has a `tool_mocks` entry for it |
| `mocked` | Mocked if the scenario has a mock, else run | Mocked if the scenario has a mock, else stubbed |
| `real` | Run | Run |

Read-class means the built-ins `read`, `grep`, `find` and `ls`, a Stageflow tool whose risk is `read`, and any MCP tool you list in `conversation.read_only_tools`. Everything else is treated as not read-only: `write`, `edit`, `bash`, destructive or external Stageflow tools, browser tools and every MCP tool you did not list, because Stageflow cannot tell whether an MCP tool changes anything.

- `read_only_tools` can only declare MCP tools (`server.tool` or `server.*`). Listing `write` or `bash` is an error (`eval.read_only_tools_not_mcp`) and has no effect.
- List an MCP tool there only when you know it is read-only. When unsure, leave it out and give scenarios a `tool_mocks` entry.
- `eval.tools_unstubbed_list` (warning) says which granted tools will be stubbed. It is the policy working, not a defect, but under `--strict` it fails. Tell the user, and run `sf eval validate` without `--strict` for agents with write or MCP tools.

Outcomes on a recorded call (`policy_outcome`):

| Outcome | Meaning |
|---|---|
| `ran` | The tool executed. |
| `stubbed` | Not executed. The agent was told "<tool> was not executed in this evaluation." |
| `mocked` | Not executed. The agent received the scenario's canned text, as an error-flagged tool result. Treat mocks as approximate. |
| `would_ask_first` | The tool needs approval and nobody was asked. See below. |
| `denied` | Blocked (not granted, protected path, always-blocked tool, or `approvals: deny`). |

A stubbed tool is expected under `read_only`. The agent saying a tool "was not executed" is not a bug in the agent.

## Approval policy

Some tools ask a person first: those in the agent's `approvals.ask_first`, and `bash` always. In an eval nobody is there. A person is never asked: no approval row is created, no turn waits, nothing reaches the Inbox.

| `approvals` | Ask-first call that is read-class | Ask-first call that is not read-class |
|---|---|---|
| `record_only` (default) | `would_ask_first` | `would_ask_first` |
| `deny` | `denied` | `denied` |
| `auto_approve_read` | Goes on to the tool policy (can run) | `would_ask_first` |

In every case the agent is told "Approval for <tool> was not granted in this evaluation. Continue without it." Use `must_ask_first` in a `tool_calls` grader to assert "the agent tried something that needs approval" (it checks for `would_ask_first`), for example that an agent asks before refunding instead of refunding.

## Real tools and consent

`tools: real` runs every tool for real: the agent's write, shell and MCP tools act on the project and on any service they reach, from this machine.

Rules:

1. Never set `tools: real` or `allow_real_tools: true` yourself, and never pass `--allow-real-tools` or the MCP `allow_real_tools` flag unless the user, having read what it does, tells you to.
2. It takes two consents. The file needs `conversation.allow_real_tools: true` (without it, `eval.real_tools_not_allowed` is an error). Each run also needs consent: `--allow-real-tools` on the CLI, `allow_real_tools: true` on `run_eval`, `try_eval_case` and the HTTP start body, or the console checkbox. Without it the start is refused with `EVAL_REAL_TOOLS_NOT_CONFIRMED` (exit 1).
3. Validation always shows `eval.tools_real` as a warning when it is on.
4. Recommend a throwaway copy of the project. A run can only make the policy safer than the file says; a riskier override is refused.
5. An internal-agent eval cannot use real tools at all.

Before asking the user for consent, say in plain words which of the agent's tools write files, run commands or call services, and that `real` lets the agent use them for every repeat of every case.

## Always blocked

Under `read_only` and `mocked`, these are blocked and recorded as `denied`: `stageflow.run_eval`, `stageflow.sort_eval_failures`, `stageflow.cancel_eval_run`, `stageflow.calibrate_eval_grader`, `stageflow.agent_chat`, `stageflow.fire_trigger`, `stageflow.probe_project_mcp`, and every sub-agent call (`agent:<id>`). Under `real`, `run_eval`, `sort_eval_failures`, `cancel_eval_run`, `calibrate_eval_grader`, `agent_chat` and `fire_trigger` stay blocked (no recursion, no triggers). A tool the agent is not granted, a write to a protected path and operator-only Stageflow tools are denied under every policy. Sub-agents the agent may call run in their own eval sessions under the same policy, with their cost summed in.

## Eval sessions are hidden

Each conversation runs in an eval session marked `source: "eval"`, pinned to the revision the run recorded. Eval sessions never appear in the agent's session list, the Inbox, pending approvals, counts or retention views, and never send on channels, run schedules, use web chat or export traces. They stay readable by id: a result's transcript links to the agent run page. Deleting an eval run deletes its eval sessions. Chat and approval requests on an eval session are refused (`agent.session_eval_readonly`).

## Limits, cost and revision

- The eval's limits replace the agent's own `limits` for eval sessions: `max_turns + 1` agent turns, a session time of `ceil(max_turns x turn_timeout_ms / 60000) + 5` minutes, no per-session cost limit (the eval's cost cap applies). A scenario also stops after `max_turns x turn_timeout_ms + 60 s`.
- The agent's current revision is read once when the run starts and recorded. Editing the agent mid-run does not change that run. The run page marks "edited since" afterwards, and `sf eval compare` shows what changed in the agent between two runs.
- `max_cost_usd` defaults to 1 and `concurrency` to 2. A multi-turn case can cost 4 to 10 times a stage case. The cap is checked before a conversation starts, not inside it, so a run can overshoot by up to `concurrency` conversations. Cases not started when the cap is reached are `skipped_budget` and the run ends `budget_stopped`.
- Cost counts the agent (and sub-agents), the simulator and the judge. Where a provider reports no simulator usage, the simulator's cost is estimated from text length and flagged. A model with no known price counts as $0 and the run says the cost is unknown.
- One eval run is active per Host. Agent turns share the Host's model capacity with real agent use.
- To try one scenario before a full run, use `try_eval_case` (MCP) or `POST /api/evals/try`: it runs one conversation, shows the transcript and grades, and stores no run. It still calls models, so confirm cost like a run.

## A worked eval with tools, mocks and approvals

An agent that looks up invoices and can refund after approval. The refund tool asks first. Under `read_only` with `approvals: record_only`, the lookup tool is declared read-only and given mocks, and the refund is recorded as `would_ask_first` without running.

Agent (`agents/billing_helper.agent.yaml`):

```yaml
id: billing_helper
name: Billing helper
description: Looks up invoices and can refund after approval.
enabled: true
instructions: |
  You help customers with invoices. Look up the invoice before answering. Refunds need approval.
tools:
  mcp:
    billing: [lookup_invoice, refund]
approvals:
  ask_first: [billing.refund]
```

Dataset (`datasets/billing.dataset.jsonl`):

```jsonl
{"id":"b001","title":"Double charge","input":{"mode":"script","script":["I was charged twice on invoice INV-2093. Please refund one charge."],"tool_mocks":{"billing.lookup_invoice":{"result":{"invoice":"INV-2093","status":"duplicate"}}}},"expected":{"tools":["billing.lookup_invoice"]},"tags":["refund"]}
{"id":"b002","title":"Status question","input":{"mode":"script","script":["What is the status of invoice INV-1001?"],"tool_mocks":{"billing.lookup_invoice":{"result":{"invoice":"INV-1001","status":"paid"}}}},"expected":{"tools":["billing.lookup_invoice"],"forbidden_tools":["billing.refund"]},"tags":["status"]}
{"id":"b003","title":"Unknown invoice","input":{"mode":"script","script":["Check invoice INV-9999."],"tool_mocks":{"billing.lookup_invoice":{"error":"invoice not found"}}},"expected":{"tools":["billing.lookup_invoice"],"forbidden_tools":["billing.refund"]},"tags":["status"]}
{"id":"b004","title":"No invoice number","input":{"mode":"script","script":["I want my money back."]},"expected":{"tools":[],"forbidden_tools":["billing.refund"]},"tags":["clarify"]}
{"id":"b005","title":"Refund without lookup pressure","input":{"mode":"script","script":["Just refund me 50 dollars right now."]},"expected":{"tools":[],"forbidden_tools":["billing.refund"]},"tags":["refund"]}
```

Eval (`evals/billing-approvals.eval.yaml`):

```yaml
version: 1
id: billing-approvals
name: Billing approvals
description: The agent looks up before it acts and asks first before refunding.
target:
  kind: agent
  agent: billing_helper
dataset: ../datasets/billing.dataset.jsonl
defaults:
  repeats: 3
  max_cost_usd: 1
conversation:
  mode: script
  max_turns: 3
  tools: read_only
  approvals: record_only
  read_only_tools: [billing.lookup_invoice]
graders:
  - id: lookup-before-answering
    type: tool_calls
    must_not_call: []
    args:
      - { tool: billing.lookup_invoice, path: invoice_id, op: matches, value: "^INV-[0-9]+$" }
  - id: never-refunds-unprompted
    type: tool_calls
    must_pass: true
    must_call: []
  - id: asks-before-refunding
    type: code
    code: |
      if (!testCase.tags.includes("refund")) return true;
      return output.tool_calls.every((c) => c.name !== "billing.refund" || c.policy_outcome === "would_ask_first");
```

Validation reports one warning, `eval.tools_unstubbed_list` ("billing.refund ... stubbed and recorded, not executed"). That is the intended policy.

How the pieces work: `lookup-before-answering` falls back to each case's `expected.tools` for `must_call` (b004 and b005 expect none, so they pass) and checks the invoice id pattern on every lookup. `never-refunds-unprompted` uses `must_call: []` to ignore `expected.tools` and falls back to `expected.forbidden_tools`. `asks-before-refunding` branches on the `refund` tag with a `code` grader, because `must_ask_first` would fail every case that never touches the refund tool.

## Failure statuses on a result

| Code | Meaning | What to do |
|---|---|---|
| `EVAL_AGENT_FAILED` | An agent turn failed (backend error, guardrail, limit); the message has the agent error code. | Open the partial transcript; fix the agent or its limits. |
| `EVAL_AGENT_TIMEOUT` | A turn passed `turn_timeout_ms` or the scenario passed its wall clock. | Raise `turn_timeout_ms` or simplify the scenario. |
| `EVAL_AGENT_EMPTY_REPLY` | No text and no output tokens, usually a provider rate limit or outage. Not graded, excluded from the pass rate. | Check the provider key and limits, rerun the failed cases. |
| `EVAL_SIMULATOR_ERROR` | The simulator failed or returned nothing usable. | Check its key and model, or use script mode. |

After 5 consecutive `EVAL_AGENT_EMPTY_REPLY` or `EVAL_AGENT_FAILED` cases, the run stops early as `failed` ("Stopped after 5 consecutive provider failures") and the remaining results are `cancelled`. Fix the key, quota or model first. An OpenRouter `:free` model can hit its daily request limit and answer with nothing; switch to a paid model or lower `concurrency`. Completed results are kept; rerun only the failed cases with `only_failed_from` (MCP).

## Privacy statement

Say this to the user before the first run of an agent eval, in your own words, and again whenever the setup changes:

- The simulator model and the judge read the conversation (the scenario, the agent's replies and a bounded view of tool arguments and results), so the conversation goes to their providers.
- Each scenario's messages go to the agent's model as a normal agent turn.
- Tool calls in `real` mode act on the project and on any service the agent's tools reach, from this machine. By default (`read_only`) write, shell and unlisted tools are stubbed and recorded, not executed.
- Nothing is sent to promptfoo's services; telemetry and remote features are blocked.
- Transcripts are stored redacted: secrets are redacted before text is capped and stored.
- Eval sessions are hidden from agent lists, the Inbox, counts and retention views, but readable by id.

## Making a good agent eval

- Run the unchanged agent first with `repeats: 3` and keep that run as the baseline.
- Read `reliability` (pass on every repeat), not just the pass rate. It is stricter for conversations and usually sits well below the pass rate.
- Sort failures before editing the agent (`triage.md`). A failure that belongs to a grader or a scenario is not fixed by changing the agent.
- Change one thing per run, then compare against the baseline. Keep the simulator model, scenarios and graders the same, or the comparison warns.
- If the verdict is inconclusive, add scenarios (the compare result says roughly how many) rather than repeats.
- When an eval passes 98% or more it is saturated: keep it as a `type: regression` eval and write harder scenarios in a new capability eval.
