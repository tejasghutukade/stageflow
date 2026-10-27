import type { GuideKnowledgeTopic } from "../index.js";

export const bestPracticesTopic: GuideKnowledgeTopic = {
  id: "best_practices",
  title: "Best practices for building on Stageflow",
  summary:
    "Opinionated, product-specific advice: small stages with typed io, real verify checks, gates only where a person decides, run once before adding a trigger, evals before relying on a stage or agent, safe agent grants, cost limits.",
  body: `# Best practices

Each point follows from how Stageflow behaves.

## Designing pipelines

1. **Start with one or two stages and run them.** Every stage is a fresh model session, so each extra stage costs time and money and adds a handoff. Split a stage only when a step has its own output, needs another model or tools, needs a person's decision, or needs its own check.
2. **Make the output schema carry the handoff.** The next stage reads the parent's \`payload\` and \`summary\`, not the transcript. Put every fact the next stage needs into required fields of \`io.output.schema\`. Keep \`io.input.schema\` of the child a subset of the parent's output, or the pipeline will not load (\`pipeline.io_incompatible\`).
3. **Make fields you branch on required.** A route \`if\` can only read required, non-array fields. Add an explicit field such as \`severity\` or \`needs_review: boolean\` rather than asking the model to decide successors.
4. **Do not use \`on: [failed]\` to build a "failure path".** It does not launch a stage after a failure. Model the decision as a succeeded payload field and branch with \`if\`.
5. **Name the payload in the prompt.** Tell the stage exactly which fields to put in \`payload\`, what to write as artifacts, and to call \`emit_stage_envelope\` once at the end.
6. **Follow the Artifact contract for file handoff.** Durable files only via \`write_stage_artifact\`; list those returned paths on emit (emit rejects missing files). Prefer required \`payload\` fields for facts. Under a stage sandbox, teach the consumer to read \`/workspace/grants/…\` (or payload), never \`stages/…/artifacts\` host paths and never \`/workspace/work\` as handoff. Do not add after-phase \`verify\` \`type: artifact\` on every bare \`create_stage\` — only when an explicit basename needs hard proof.
7. **Use the pipeline \`model\` default** so stages follow one setting. When adding stages with tools, pass the model explicitly or the Host default gets written into each stage file.
8. **Clone chains for "do this for each item".** Gate the empty-list case before the emitter (an empty array fails the emitter), and set \`clone_cap\` to a real maximum.

## Checks

9. **Back up claims with after-phase \`verify\`.** A \`command\` check (tests, a linter, a script that checks the output) or an \`artifact\` with \`path\` and \`nonempty: true\` is evidence. A \`checklist\` is only the agent's word; pair it with a real check. Emit disk-truth already requires listed files to exist; after-phase artifact verify is optional extra proof, not a default on every stage.
10. **Use \`on_verify_fail: repair\` only for repeatable work** (\`retry_safety: idempotent\`) with a small \`max_attempts\` such as 2 or 3. Use \`mode: manual\` for anything that publishes, pays, sends or deploys.
11. **Make approvals binding.** \`gate_kinds\` alone lets the agent skip the question. Add \`verify: [{ type: gate, kind: confirm }]\` (or \`artifact_backed\`) so success cannot be emitted without an accepted answer.

## People in the loop

12. **Add a gate only where a person must decide** (approve a plan, confirm a send, choose between options). Every gate stops the run until someone answers, blocks CI unless \`--skip-gates\` (which fails instead), and makes the stage impossible to evaluate (\`EVAL_STAGE_NEEDS_INPUT\`).
13. **Put side effects after the decision.** Put the send or publish stage after the gated stage, with \`replay_safe: false\` if a feedback loop could replay it.

## Sending messages

14. **One channel per stage.** Two providers means two stages. Write the message content in the stage before the send, so the send stage stays small.
15. **Test the connection before the run** (\`test_connection\`) and check the recipient (\`validate_connection_target\`). Telegram, iMessage and WhatsApp have extra rules (start the bot first, text the line first, 24-hour window).
16. **Never resend an unknown outcome.** If a send reports \`CHANNEL_SEND_OUTCOME_UNKNOWN\`, check with the recipient first.

## Triggers

17. **Create a catalog task and run the pipeline by hand once before adding a trigger.** Then add the trigger with that task. Schedules need a catalog task.
18. **Start triggers disabled if the pipeline sends messages or costs a lot**, then enable after a manual fire works.
19. **For event triggers in dynamic mode, shape the entry stage's input schema around the event's fields** (GitHub: \`action\`, \`number\`, \`title\`, \`url\`, \`author\`, \`repo\`, \`updatedAt\`; email: \`from\`, \`subject\`, \`date\`, \`text\`).

## Agents

20. **Grant the least.** Start with \`read\` tools and the specific Stageflow tools needed. \`bash\` is always ask-first and not path-confined; avoid it for agents that should stay confined.
21. **Put risky tools in \`approvals.ask_first\`**, and keep \`approvers.operators: true\` (channel approvers are ignored, so turning operators off leaves nobody able to decide).
22. **Set limits.** Keep \`max_turns\`, \`session_minutes\` and \`cost_usd\` for public web chat and channel agents. With \`always_on\`, \`cost_usd\` is per day.
23. **Lock down reach.** Use a specific \`allow_from\` list, not \`*\`. Treat the web chat link as a password; rotate it with \`slug: ""\`. A web chat agent that can read agent sessions can read visitors' messages.
24. **Enable last.** Agents are created disabled. Validate, try it in the console session page, then enable.

## Memories

25. **Write a clear description** (the session only sees id and description until it calls a tool), use stable card keys (email, ticket id), and keep cards under 64,000 characters and 200 per memory.

## Evals

26. **Add an eval before you rely on a stage or agent, and before changing its prompt, model or tools.** Start with deterministic graders (\`schema\`, \`field\`, \`tool_calls\`, \`conversation_check\`); add \`rubric\` or \`goal_reached\` for what rules cannot say.
27. **At least 5 cases, \`repeats: 3\`.** Fewer cases give wide intervals; one repeat hides flakiness. Read reliability (pass on every repeat), not only pass rate.
28. **Baseline first, change one thing per run, compare.** Use a judge model different from the target's model.
29. **Keep agent evals on \`read_only\`.** Use \`tool_mocks\` for tools that would change things. Use \`real\` only on a throwaway copy of the project.
30. **Keep \`max_cost_usd\` and \`concurrency\` low** (defaults 2 and 4 for stages, 1 and 2 for agents) until you know the cost per case.

## Cost control in general

Pipelines have no run-level cost cap. Control cost with cheaper models for simple stages, fewer stages, small \`max_attempts\` for repair, \`timeout_ms\` on long stages, agent \`limits.cost_usd\`, and eval \`max_cost_usd\`.
`,
};
