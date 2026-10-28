import type { GuideKnowledgeTopic } from "../index.js";

export const evalsTopic: GuideKnowledgeTopic = {
  id: "evals",
  title: "Evals: checking a stage or an agent",
  summary:
    "Stage vs agent evals, datasets and scenarios, graders and which target kind each applies to, repeats and statistics, cost cap, judge providers, the engine install, read_only tool policy, the two consents for real tools, and sorting failures.",
  body: `# Evals

An eval (\`evals/<id>.eval.yaml\`) runs one **target** over a **dataset** of cases, grades every result with **graders**, repeats each case, and lets you compare runs. Results are stored and survive restarts. Saving an eval never changes past runs.

## Target

- Stage: \`target: { kind: stage, pipeline: <path>, stage: <id> }\` or \`{ kind: stage, file: <stage file> }\`. Paths are relative to the eval file. Each case becomes a normal stage run (hidden from the Runs list), with \`input\` from the case and \`goal\` from the case, the eval's \`task.goal\`, or "Evaluate case <id>".
- Agent: \`target: { kind: agent, agent: <id> }\`. Each case is a conversation in a hidden eval session on the agent's current revision. No \`task\` block on agent targets.

## Dataset

A file in \`datasets/\`: \`.dataset.jsonl\` (editable in the console), \`.dataset.json\` or \`.dataset.csv\` (read-only in the console; convert to JSONL). Each case: \`id\` (required, stable), \`input\` (required object), optional \`title\`, \`expected\`, \`tags\`, \`goal\`, \`metadata\`. For a stage, \`input\` must match the stage's \`io.input.schema\`; cases that do not are skipped (\`dataset.input_mismatch\`, \`eval.cases_skipped\`). Fewer than 5 cases warns. Limits: 5,000 cases.

For an agent, \`input\` is a **scenario**: \`mode: script\` with \`script\` (1–40 user messages), or \`mode: simulated\` with \`opening\`, \`persona\`, \`goal\` and optional \`facts\`. Optional \`tool_mocks\`. \`expected\` may hold \`outcome\`, \`tools\`, \`forbidden_tools\`.

## Graders

Common keys: \`id\`, \`type\`, \`weight\` (default 1), \`must_pass\` (a failure fails the result). 1 to 20 graders.

| Type | Stage | Agent | What it checks |
|---|---|---|---|
| \`schema\` | yes | no | Success envelope whose payload matches \`io.output.schema\`. |
| \`field\` | yes | yes | Values at paths (\`exists\`, \`equals\`, \`contains\`, \`matches\`, \`in\`, \`length_gte\`, …). |
| \`reference\` | yes | yes | Compares with the case's \`expected\` (\`each_mentioned\` or \`equals\`). |
| \`rubric\` | yes | yes | A judge model grades against your words (\`pass_fail\` or \`1_to_5\`). Needs a judge. |
| \`code\` | yes | yes | A JavaScript function body; runs on the Host with your permissions, 5 s limit. |
| \`tool_calls\` | no | yes | \`must_call\`, \`must_not_call\`, \`must_ask_first\`, \`max_calls\`, \`args\`. |
| \`conversation_check\` | no | yes | \`max_turns\`, \`max_agent_questions_per_turn\`, \`final_reply\` checks. |
| \`goal_reached\` | no | yes | A judge decides whether the scenario goal was met. Needs a judge. |

A grader on the wrong kind is \`eval.grader_not_applicable\`. There is no \`command\` or \`groundedness\` grader.

## Defaults and statistics

\`repeats\` 1–10 (default 3), \`pass_threshold\` (default 0.8), \`max_cost_usd\` (default 2; agents 1), \`concurrency\` 1–8 (default 4; agents 2), \`judge\`, \`model\` (override the target's model), \`user_model\` (agent simulator, defaults to the judge). A result passes when no \`must_pass\` grader failed and its weighted score reaches \`pass_threshold\`. The run passes when its pass rate reaches \`pass_threshold\`. Reported: pass rate, a 95% interval by case, reliability (pass on every repeat), pass@k, flaky cases, latency and cost. Compare pairs two runs of the same eval by case: improved, regressed, inconclusive, or not enough data (fewer than 5 common cases).

## Cost

Every run has a cost cap (\`max_cost_usd\`) covering model calls and judge calls. When reached, the run stops as \`budget_stopped\`, remaining results are skipped, and it does not pass. For agent evals the cap is checked before each conversation starts, so a run can exceed it by up to \`concurrency\` conversations. A conversation can cost 4 to 10 times a stage case.

## Judges and the engine

- Judge and simulator models must be \`anthropic/…\`, \`openai/…\` or \`openrouter/…\`, with an API key (Pi credential of type \`api_key\` or \`ANTHROPIC_API_KEY\` / \`OPENAI_API_KEY\` / \`OPENROUTER_API_KEY\`). OAuth logins cannot judge. The stage itself can use any provider.
- Pick a judge different from the target's model (\`eval.judge_same_as_stage\` warns).
- The engine (promptfoo 0.124.0) is installed on demand: \`sf eval engine install\` (about 1.2 GB, needs Node 22.22+ and network once). Without it a run fails with \`EVAL_ENGINE_UNAVAILABLE\`.
- Only **one eval run is active per Host**. A second start fails with \`EVAL_RUN_ACTIVE\`.

## Agent eval safety

- \`conversation.tools\` defaults to \`read_only\`: read tools run; write, edit, bash, destructive or external Stageflow tools, unlisted MCP tools and browser tools are **stubbed** and recorded, not executed. List safe MCP tools in \`conversation.read_only_tools\` (built-in and Stageflow tools cannot be listed). \`mocked\` returns canned results from \`tool_mocks\`.
- \`tools: real\` needs two consents: \`conversation.allow_real_tools: true\` in the file **and** a per-run consent (\`allow_real_tools\` on \`run_eval\`, a checkbox in the console, \`--allow-real-tools\` on the CLI). Without the run consent: \`EVAL_REAL_TOOLS_NOT_CONFIRMED\`. Real tools act on the project and services from this machine.
- Approvals in evals never ask a person: \`record_only\` (default) records \`would_ask_first\`; \`deny\`; \`auto_approve_read\`.
- Always blocked in eval sessions: \`run_eval\`, \`sort_eval_failures\`, \`cancel_eval_run\`, \`agent_chat\`, \`fire_trigger\`; under \`read_only\`/\`mocked\` also \`probe_project_mcp\` and sub-agent calls.
- Eval sessions never send on channels, run schedules or use web chat, and are hidden from session lists, the Inbox and counts.

## What evals cannot do

No checkout or repository for cases. A stage that asks a person (HITL gate) records \`EVAL_STAGE_NEEDS_INPUT\`. Pipeline-entry overlays (entry-level \`mcp\`, \`secrets\`, \`requires\`, pipeline \`channels\`, \`schemas\`, \`include\`) are not applied when a pipeline stage is evaluated, so it can behave differently than inside its pipeline. No whole-pipeline evals, no scheduled evals, no judge calibration, no deleting an eval from the console.

## Sort failures

After a run, \`sort_eval_failures\` (manual only) suggests for each failed result a bucket (\`agent_wrong\`, \`grader_wrong\`, \`case_wrong\`, \`unclear\`) and a failure type. Classifier \`jev\` (TypeSafe; needs a TypeSafe key, about $0.04 per million input tokens, outside the cost cap) or \`judge\` (the run's judge model). Nothing is tagged until someone accepts (\`accept_eval_failure_suggestions\`).

## Tools

Read (free): \`list_evals\`, \`get_eval\`, \`validate_eval\`, \`list_eval_runs\`, \`get_eval_run\`, \`get_eval_results\`, \`get_eval_result\`, \`compare_eval_runs\`, \`get_eval_failure_suggestions\`, \`get_eval_failure_sort_status\`, \`get_eval_run_export\`. Write: \`create_eval\`, \`update_eval\`, \`create_dataset\`, \`update_dataset_cases\`, \`convert_dataset\`, \`install_eval_sample\`, \`put_eval_review\`, \`accept_eval_failure_suggestions\`, \`dismiss_eval_failure_suggestions\`. Costs money: \`run_eval\`, \`try_eval_case\`, \`sort_eval_failures\`. Also \`cancel_eval_run\`, \`delete_eval_run\` (destructive).
`,
};
