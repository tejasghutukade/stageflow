import type { GuideKnowledgeTopic } from "../index.js";

export const troubleshootingTopic: GuideKnowledgeTopic = {
  id: "troubleshooting",
  title: "Troubleshooting: common findings and errors",
  summary:
    "What common validation finding codes and run, trigger, channel, agent and eval errors mean, and how to fix each one.",
  body: `# Troubleshooting

Run \`validate\` (or \`validate_catalog_draft\` for a draft, \`validate_agent\`, \`validate_eval\`) first. Findings have a \`code\`; errors block, warnings do not.

## Pipelines and stages

| Code or message | Meaning and fix |
|---|---|
| "model is required (set on stage, pipeline, or stageflow.yaml)" | No model anywhere in the chain. Set pipeline \`model\` or \`stageflow.yaml\` \`model\`. |
| \`stage.invalid_io\` | A stage body lacks \`io.input.schema\` or \`io.output.schema\`. Both are required. |
| \`pipeline.io_incompatible\` | A child's input schema is not a subset of a parent's output schema. Make the child require only fields the parent's output declares. |
| \`pipeline.route_if_invalid\` | Bad \`if\`: unknown operator, field not required in the source output, array path, mixed shape, or \`if\` on a loop entry. |
| \`pipeline.route_all_gated\` (warning) | Every forward route has \`if\`; the run may skip all successors. |
| \`pipeline.model_applies\` (warning) | The pipeline \`model\` fills stages. Informational. |
| \`pipeline.dag_error\` | A cycle, or a backward or circular edge without a \`type: loop\` entry. |
| \`"needs" is no longer supported …\` (also \`fork\`, \`feedback_loop\`, \`route_select\`, \`allow_none\`) | Old wiring. Put \`route: [{ to: child }]\` on the parent and \`entry: true\` on roots; loops become a \`type: loop\` route entry. |
| \`pipeline.stage_uses_inline_conflict\` | Body keys beside \`uses:\`. Move them into the stage file. |
| \`pipeline.stage_wrapper_skill_rejected\` | \`skill\` on a \`uses:\` wrapper. Put it in the stage file. |
| \`stage.unresolved_schema_ref\` | A \`$ref\` stage validated alone; validate the pipeline that defines \`schemas\`. |
| \`catalog.legacy_yaml\` (warning) | Old contract keys (\`payload_schema:\`, \`pre_emit_checks\`, \`completion\`, \`recovery\`). Convert with \`sf migrate-yaml --write\`. |
| \`pipeline.invalid_memories\` / \`pipeline.memory_unavailable\` | Duplicate memory id, or a memory that does not exist on this Host. Create it first. |
| \`pipeline.invalid_shape\` | Wrong structure, including \`memories\` on a stage entry. |
| \`stage.invalid_channels\` / \`pipeline.invalid_channels\` | Bad \`channels\` shape, or more than one channel on a stage. |
| \`stage.channel_unavailable\` | Connection missing or disabled, operation unsupported, or recipient invalid for the provider. |
| \`stage.invalid_browser\` | Unknown \`browser\` key, or \`path\`, \`scope\`, \`secret\`, launch options in YAML. |
| \`stage.invalid_requires\` / \`pipeline.invalid_requires\` / \`pipeline.requires_conflict\` | Bad \`requires\` entries, or version ranges that cannot both hold. |
| \`stage.unknown_secret\` | A \`secrets\` name that is neither a console MCP secret nor a registered Host secret. |
| "Unknown MCP server" | A stage \`mcp\` name in neither \`.mcp.json\` nor the console list. |
| Clone chain errors | Extra routes on emitter or child, \`if\` on chain edges, extra join parents, inline array items, \`clone_cap\`/\`clone_mode\` on the wrong stage. |

## Running

| Symptom | Meaning and fix |
|---|---|
| \`task.invalid_shape\` at run start | The task's \`input\` does not match the entry stage's \`io.input.schema\` (missing \`input\` counts as \`{}\`). |
| \`channel_check_failed: <connection>: <reason>\` | Live connection check failed. Fix the key or recipient; \`test_connection\`. |
| \`missing emit_stage_envelope\` | The agent ended without a valid envelope after two reminders. Make the prompt name the payload fields; check \`io.output.schema\` is achievable. |
| \`provider error: …\` | Usually a missing or invalid provider key or an unavailable model. Check Settings → Providers. |
| \`stage timed out after …ms\` | Raise \`timeout_ms\` or simplify; the session is kept, so Resume works. |
| Run waiting | A stage asked a person. Answer in the Inbox. |
| Stage failed after-phase verify | See the stage's verification history (\`get_stage_verification\`). With \`mode: manual\`, use Retry with guidance or Stop recovery; plain retry is refused. |
| Join never runs | One parent failed. A join does not run on a failed parent. |
| "waiting for browser profile" | Another run holds the browser profile until it ends. |
| Stage fails with \`site blocked this browser:\` | The site challenged or rejected the Host's browser. With \`browser.attach\` configured the Host pins the profile to the operator's Chrome and retries the stage once; without it the stage fails. Console Connections → Browser logins shows the pin, and Switch back tries the Host's browser again. |
| Login worked but a headless stage sees a logged-out page | The site rejected the copied session. Try the stage headed (drop \`headed: false\`), or pin the profile to the operator's Chrome with \`browser.profile_hosts\`. |
| Check now or Log in again is disabled | No recorded check yet (run a pipeline whose stage has \`browser.check\` and this profile once), a run holds the profile, or the Host has no window to offer (set \`browser.login_host: attach\`). |

## Triggers

| Code | Meaning |
|---|---|
| \`trigger.invalid_shape\` | Missing or wrong \`id\`, \`pipeline\`, \`kind\`, \`enabled\`. |
| \`trigger.unknown_pipeline\` / \`trigger.unknown_task\` | The id is not in the catalog. |
| \`trigger.task_required\` | Dynamic trigger fired without a task (always the case for a schedule without \`task\`). |
| \`trigger.task_override_not_allowed\` | A task was passed to a catalog-mode trigger. |
| 409 on fire | The trigger is disabled. |
| Webhook 401 | Signature does not match the secret and header. |

## Channels

\`CHANNEL_AUTH_FAILED\` (bad credential), \`CHANNEL_UNAUTHORIZED\` (missing scope, or stage did not declare the channel), \`CHANNEL_SECRET_UNAVAILABLE\` (env secret not set on this Host), \`CHANNEL_TARGET_INVALID\`, \`CHANNEL_RECIPIENT_REJECTED\` (bot not added, user did not start the bot or text the line), \`CHANNEL_WINDOW_CLOSED\` (WhatsApp 24-hour window; pin a template), \`CHANNEL_RATE_LIMIT\`/\`CHANNEL_TIMEOUT\`/\`CHANNEL_CONNECTION_FAILED\` (retryable), \`CHANNEL_PROVIDER_UNSUPPORTED\` (optional iMessage/WhatsApp packages missing), \`CHANNEL_SEND_OUTCOME_UNKNOWN\` (do not resend), \`CHANNEL_OPERATION_CONFLICT\` (same key, different content).

## Agents

| Code | Meaning |
|---|---|
| \`agent.invalid\` | Issues block the save; each has a field \`path\`. |
| \`agent.unknown_field\`, \`agent.required\` | Typo or missing field. |
| \`agent.ask_first_not_granted\` | \`ask_first\` names a tool the agent does not hold. |
| \`agent.stageflow_operator_only\` | Tried to grant \`gates.decide\` or \`get_started\`. |
| \`agent.channel_in_use\` | That connection (or its inbox) already belongs to another agent. |
| \`agent.memory_unavailable\` | A memory id does not exist. |
| \`agent.conflict\` | Saved from an old revision; reload and reapply. |
| \`agent.disabled\`, \`agent.limit_reached\`, \`agent.session_busy\` | Turn refused: disabled, a limit hit, or a turn/approval already pending. |
| \`agent.guardrail_blocked\` | A \`block_patterns\` regex matched the reply. |
| \`agent.model_timeout\` | The model sent nothing for 180 s. |
| \`agent.reply_undelivered\` | A channel reply failed or its outcome is unknown; Resend or Mark as delivered on the run page. |
| Warnings: \`agent.mcp_server_unknown\`, \`agent.skill_unknown\`, \`agent.model_unknown\`, \`agent.connection_unknown\`, \`agent.channel_nobody_allowed\`, \`agent.channel_open_to_anyone\`, \`agent.shell_not_path_confined\`, \`agent.web_chat_reads_conversations\` | Advice; the agent still saves. |

## Evals

\`eval.target_unresolved\` (target does not load, often no default model), \`eval.grader_not_applicable\`, \`eval.judge_missing\`, \`eval.schema_grader_without_output_schema\`, \`eval.no_valid_cases\`, \`eval.cases_skipped\`, \`eval.real_tools_not_allowed\`, \`eval.user_model_missing\`, \`eval.simulator_unsupported\`, \`eval.agent_not_found\`, \`eval.agent_archived\`. At run: \`EVAL_ENGINE_UNAVAILABLE\` (install the engine), \`EVAL_NODE_TOO_OLD\`, \`EVAL_RUN_ACTIVE\`, \`EVAL_REAL_TOOLS_NOT_CONFIRMED\`, \`EVAL_INVALID\` (including an unsupported judge provider), \`budget_stopped\` (raise \`max_cost_usd\` or run fewer cases). On results: \`EVAL_STAGE_NEEDS_INPUT\`, \`EVAL_STAGE_TIMEOUT\`, \`EVAL_JUDGE_ERROR\` (judge key missing or non-JSON reply), \`EVAL_CASE_MISSING_EXPECTED\`, \`EVAL_AGENT_EMPTY_REPLY\` (provider rate limit or outage). Saving: \`FILE_CHANGED\` (reload and reapply).
`,
};
