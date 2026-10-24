# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.43.0] - 2026-10-24

### Added

- **Long Pi sessions compact themselves, and compaction keeps what matters.** Pipeline stages, project agents and the operator agent now compact their context when the window fills. This is always on and has no setting. The summary is written by the same model the stage or agent uses, with a prompt that asks for exact values, failures and dead ends, in-flight state and the next step. Stageflow appends four sections it builds itself: pinned facts (ids, numbers, timestamps, URLs, paths, errors), operator and user directives copied verbatim, an index of cleared tool results, and the working state. Secrets are removed before the summarizer reads the transcript and from its output. If building the summary fails, Pi's default compaction runs. See [Context and compaction](docs/context-and-compaction.md).
- **`working_state` tool.** Stages, project agents and the operator agent can keep keyed entries (facts, decisions, progress, to-dos, blockers). They are saved with the session, survive resume, and are shown again after every compaction. Values go through the same secret scrubber as the rest of compaction, and the tool tells the model when it redacted part of a value. Its guidance is in every stage, agent and operator system prompt.
- **Context size and compactions in the console.** The stage inspector has a Context row (tokens used of the window) that falls after a compaction, and the events list shows **Context compacted** with tokens before and after, summary size and cost. The compaction call is charged to the stage's usage and to an agent's `limits.cost_usd` like any other model call.
- **`compaction-stress` example and `scripts/compaction-eval`.** A three-stage incident postmortem that reads about 1 MB of logs through a context window that forces a compaction, with a checker (`check-run.mjs`), and an offline harness that scores compaction strategies on seven scenario types.

### Changed

- **A Pi stage's assignment and envelope contract are in the system prompt.** The task, prior envelopes, `payload_schema`, checklist and guidance used to be the first user message, which compaction could summarize. The first user message is now a one-line kickoff.
- **`read` and `bash` share a per-turn token cap.** The first result of a turn always returns. Later results in the same turn (parallel calls) are replaced by a short notice once the turn would pass 40% of the window or the space left after the reserve, and the model repeats the call in a later turn.
- **Emit reminders reset on progress.** A stage is reminded twice in a row without a tool call in between; a reminder turn that runs a tool call resets the count, with a ceiling of 20. A stage that ends on a tool call the model wrote out as plain text now fails with a provider error that says so, instead of `missing emit_stage_envelope`.
- **OpenRouter requests that carry tools ask for providers that support them** (`require_parameters`), unless routing is set in `models.json`. See [Providers](docs/providers.md#openrouter-routing).
- **The Claude backend pins the SDK's auto-compaction on.**

## [0.42.0] - 2026-10-23

### Added

- **Agent author keeps a draft.** The create page interviews before it fills the config, shows the chat model, and stores the draft and transcript. Leave the page and open the draft again from **Drafts** on Agents.
- **The author reads documentation only.** `read_project_file` and `list_project_files` allow `docs/`, `policies/`, `AGENTS.md`, and `README.md`, and only `.md` and `.txt`. Source files are refused.
- **The author can see what is already connected.** `list_author_catalog` returns connection ids with provider labels and installed skill names. It does not return secrets, and it does not grant a name that is not listed.
- **Document policy review example.** `examples/document-policy-review/` is a generic agent that compares a document to company policies, with a public chat page. `docker-compose.policy-review.yml` publishes that host on port 3849.
- **Agent author on Cursor keeps one draft.** A Cursor composer lists the `pi__` tool names, the create page uses one session, and an edit made while the author is still replying is not overwritten.

## [0.41.0] - 2026-10-23

### Added

- **Evals: measure whether a stage still works.** An eval is a YAML file (`*.eval.yaml`) that points at one pipeline stage and a dataset of cases (JSONL or JSON), runs every case several times (`repeats`) in a fresh stage session, grades each output, and reports a pass rate with a confidence interval, reliability across repeats, flaky cases, latency, cost and failure tags. The console has an Evals page (list, results, case drawer with review and tags, Edit with a dataset editor, and a new-eval wizard), an installable sample (`POST /api/evals/sample`, `examples/evals/`), and `GET`/`POST` routes under `/api/evals`, `/api/eval-runs`, `/api/eval-compare` and `/api/datasets`. Results live in `state.db`; eval stage runs do not appear in Runs or Inbox. See [Evals](docs/evals.md) and [Console: Evals](docs/console-evals.md).
- **Graders: five kinds, three need no model.** `schema`, `field`, `reference` and `code` graders are deterministic and free; `rubric` graders ask a judge model and are scored on a pass/fail or 1-to-5 scale. A weighted score is compared with `pass_threshold`, and `must_pass` graders fail the result on their own.
- **Compare two runs.** Compare shows the paired difference with a confidence interval and a verdict (improved, regressed, no clear difference or insufficient data), per-case and per-grader changes, a line diff of the changed system prompt, and warnings when datasets or graders differ. A run stores a snapshot of the stage, dataset, graders and settings it used.
- **`sf eval` and MCP.** `sf eval validate`, `sf eval run` (`--json`, exit `0` when the run passed, `1` below the threshold or failed), `sf eval engine status|install`, and MCP tools `list_evals`, `get_eval`, `validate_eval`, `run_eval` (with `wait: true`), `get_eval_run`, `list_eval_runs`, `get_eval_results`, `get_eval_result`, `compare_eval_runs` and `cancel_eval_run`. `sf validate` also checks evals and datasets. See [CLI reference](docs/cli-reference.md), [CI](docs/ci.md) and [MCP](docs/mcp.md).
- **On-demand engine install, Node 22.22 or newer for evals.** Evals run on a pinned promptfoo (`0.124.0`) that is not bundled: install it once with `sf eval engine install` (about 1.2 GB, network needed). Evals need Node 22.22 or newer; the rest of Stageflow still runs on Node 20 and up. The Docker image bakes the engine in at `/data/eval-engine/0.124.0`. Run costs are capped by `max_cost_usd`, and Stop run keeps the results so far.
- **Privacy: rubric graders send data to the judge's provider.** A rubric grader sends the rubric, the case input, any `expected` value and the stage output to the judge model's provider (`anthropic/`, `openai/` or `openrouter/`); the stage model's provider receives each case input too. Evals that use only deterministic graders send nothing beyond the stage's own model calls. The engine never contacts promptfoo servers.
- **Evals for agents: test how an agent holds a conversation.** An eval can now target an agent (`target: { kind: agent, agent: <id> }`) instead of a pipeline stage. Each case is a scenario the agent plays through in a fresh eval session: scripted (a fixed list of user messages) or simulated (a user model plays a persona with a goal and facts and ends the chat as resolved or abandoned). Cases repeat, are graded and feed the same pass rate, reliability, flaky-case, cost, review and Compare views as stage evals, plus mean turns and mean tool calls. Compare shows what changed in the agent (instructions, model, tools) between two revisions, and each run keeps the agent revision it used. The console adds an Agent pill in the new-eval wizard, a scenario editor, "Try one" with a transcript, a transcript tab in the case drawer, an Evals tab and Evaluate button on the agent page, and "Add as eval case" on sessions. An installable sample (`support-sample`, `POST /api/evals/sample` with `kind: "agent"`) shows the shape. See [Evals](docs/evals.md) and [Console: Evals](docs/console-evals.md).
- **Conversation graders.** `tool_calls` (must call, must not call, call count, argument checks), `conversation_check` (turn count, questions per turn, final reply checks) and `goal_reached` (a judge decides whether the scenario goal was met) join `rubric`, `field`, `reference` and `code`, which now read the conversation. Stage-only graders report `eval.grader_not_applicable` on agent evals.
- **Agent evals are read-only by default.** Tool calls run under `conversation.tools`: `read_only` (default; only read-only tools run, write and shell tools are blocked and recorded), `mocked` (answers come from the scenario's `tool_mocks`) or `real`. `real` needs `allow_real_tools: true` in the eval file and `--allow-real-tools` (or `allow_real_tools` in the API and MCP) on the run, and shows a warning. Calls that would ask for approval are denied and recorded; no approval is created, nothing reaches Inbox, and eval sessions do not appear in agent lists, Inbox counts or OTLP exports. Overrides on a run can only make the policy safer.
- **Agent evals call three models, and send the conversation to their providers.** Every run calls the agent's own model, a user simulator model in simulated mode (`user_model`) and the judge for `rubric` and `goal_reached` graders. The simulator and the judge read the conversation, including a bounded view of tool arguments and results, so they send it to their providers. Scripted evals with only deterministic graders send nothing beyond the agent's own model calls. Costs from the agent, the simulator and the judge count against `max_cost_usd`. The engine never contacts promptfoo servers. See [Evals: privacy](docs/evals.md#privacy-and-trust).
- **Evals: sort failed results automatically.** After a run, **Sort failures** (also `sf eval sort <evalRunId>`, `POST /api/eval-runs/:id/failures/sort` and the MCP tool `sort_eval_failures`) asks a small, fast classifier to suggest, for every failed or errored result, a bucket (`agent_wrong`, `grader_wrong`, `case_wrong`, `unclear`), a failure type and a confidence, plus the chance that each failing code or rubric grader is a false alarm. Suggestions are never tags until you accept them (one by one, or in bulk above 70% confidence); accepting writes the usual failure-type tag and a `bucket:<bucket>` tag. Backends: TypeSafe Jev (System One, pinned `jev-1.13.0`, about $0.04 per million input tokens; key from the stored `typesafe` provider login or `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY`) or the run's judge model. Sorting is manual only, its cost is `triage_cost_usd` (outside the run's cost limit), and `sf eval suggestions`, `GET /api/eval-runs/:id/failures/suggestions|status`, `get_eval_failure_suggestions` and `get_eval_failure_sort_status` read the results. The console shows a Suggested section on the run overview (bucket bars, suggested types, Accept all above 70%, Review suggestions), a bucket filter and Needs review filter on Cases, a bucket chip on each case, and Accept and Dismiss in the case drawer. Store migration 017 adds `eval_result_suggestions`. Privacy: sorting sends each failed result's case, output and grader reasons (bounded, redacted) to TypeSafe or to the judge model's provider. See [Evals](docs/evals.md#sort-failures).
- **`sf eval` and MCP accept agents.** `sf eval run` takes `--user-model` and `--allow-real-tools`, `sf eval list` and `show` print the agent and revision, `--json` adds `target_kind`, `agent_id`, `agent_revision`, `mean_turns` and `mean_tool_calls`, and the MCP tools `run_eval`, `get_eval_run` and `compare_eval_runs` accept the same fields. Stage evals, their results, fingerprints and exit codes are unchanged.
- **Agent evals: empty replies and provider limits no longer produce graded results.** An agent turn with no reply text and no output tokens is now an `error` result with `EVAL_AGENT_EMPTY_REPLY` (not scored), and a run stops early as `failed` after 5 consecutive empty-reply or agent-failed cases ("check your provider key or rate limit").
- **Evals console: reopen a running eval, switch runs, pick the comparison.** An eval with a queued or running run shows "Run #n running" on the Evals list and opens on its live page (`active_run` on the list and detail reads); each trend dot opens its run. The run header has a run switcher listing up to 200 runs with status and pass rate, and the live page scrolls on short windows. The Run dialog's model fields are searchable dropdowns grouped by provider, and "Compare with" can take any earlier completed run, not only the previous one.
- **Provider actions menu in Settings.** The dots button on a connected provider opens a menu with Replace API key, Sign in again and Disconnect. Disconnect asks for confirmation ("Agents and evals that use it will stop working") in the redesigned and the legacy Settings cards. A key supplied through `STAGEFLOW_PROVIDER_<ID>_API_KEY` is written again at every Host boot, so a restart restores it after a replace or disconnect.

### Changed

- **`sf validate --strict` now fails on eval warnings.** Under `--strict`, every warning on an `*.eval.yaml` file (for example `eval.tool_not_granted`, `eval.tools_unstubbed_list`, `eval.agent_disabled`) counts as an error. Existing projects with evals may now see these and exit `1` with `--strict`; without `--strict` nothing changes. The new error `eval.read_only_tools_not_mcp` (see Fixed) applies in both modes.

### Fixed

- **The eval console no longer computes statistics.** `pass_fraction`, per-case mean grader scores (`lowest_cases_by_grader` on run detail), the live mean score and Compare's `percent_change` now come from the server.
- **Backups include eval stage runs.** `sf export --all` and `/api/export` now include them.
- **Security: `read_only_tools` could make `write` or `bash` run in an agent eval.** Listing a built-in or Stageflow tool there treated it as read-only, so it ran under `read_only`. Only MCP tools can be declared read-only now; `write`, `edit`, `bash`, browser and non-read Stageflow tools stay stubbed. `sf validate` reports `eval.read_only_tools_not_mcp` (error) for such entries.
- **Eval sessions are read only for operators.** Chat and approve/deny on an eval session (HTTP, MCP `agent_chat`) are refused with `agent.session_eval_readonly`, and the console hides the composer.
- **Eval tool gate also blocks `sort_eval_failures` and `cancel_eval_run`,** even under `tools: real`.
- **Docker: the Host runs with `HOME` set to the `stageflow` user's home.** The entrypoint dropped from root to `stageflow` but left `HOME=/root`, which that user cannot write, so the email store failed and the Host restarted in a loop. The entrypoint now sets `HOME` to `/data`.

## [0.40.0] - 2026-10-21

### Added

- **Stage file tools can run in a sandbox container.** Set `STAGEFLOW_STAGE_CONTAINER_IMAGE` and `read`, `write`, `edit`, and `bash` run in a per-attempt container at `/workspace`. The stage process, memory tools, and credentials stay on the host. A stage can use the memories it was granted and cannot list the rest of `$STAGEFLOW_HOME` from bash. Leave the variable unset and those tools stay on the host.
- **Compose turns that sandbox on.** `docker-compose.yml` builds `stageflow-bash`, sets the image variable, and mounts the Docker socket. The entrypoint joins the socket's group, then drops to the `stageflow` user. Delete the variable and the socket mount to keep the tools in the Stageflow container.
- **A checkout object creates the worktree.** `checkout: { branch?, base? }` creates or reuses a git worktree. A string path still selects a checkout you already have.
- **Getting started recommends the published image.** `docker run` of `ghcr.io/tejasghutukade/stageflow:0.39` opens the console. The Node install remains available when you want `sf` on the machine.

## [0.39.0] - 2026-10-21

### Added

- **Memories.** A memory is a host folder (`$STAGEFLOW_HOME/memories/<id>/`): a cover page and cards beside it, each card filed by a key. Create it in the console first, then list its id under `memories` on a pipeline or an agent. Every stage in that pipeline, and every session of that agent, can read and replace the cover and add, update, read, and search cards. The prompt lists the ids and descriptions only. A stage or session cannot delete a card or open the previous copy. One previous copy is kept for the cover and for each card. In **Memories** the operator can edit the cover, open a card, correct it, restore the previous copy, or delete the card. See [YAML catalog — Memories](docs/yaml-catalog.md#memories).

## [0.38.0] - 2026-10-20

### Added

- **Overview, a control center for the console.** `#/overview` (pinned above Inbox in the rail) shows what needs you (gates, agent approvals and failed runs, with Accept, Reject and Retry in place for approvals and failed stages), live runs and agent sessions, system health (agent slots, providers, connections, triggers, run store size), run and success-rate trends with spend, runs by outcome, and per-pipeline success, median time and cost with a flaky tag. A 24h / 7d / 30d control sets the window. Inbox stays the home page. See [Overview](docs/console-overview.md).
- **`GET /api/overview?range=24h|7d|30d`.** One aggregate over runs and summed stage cost: totals, the previous window for comparison, rolling outcome buckets and per-pipeline rows. It reads one light row per run and loads no stages; no schema change.

## [0.37.0] - 2026-10-17

### Fixed

- **Agent turns, approvals and replies are safer.** One module (`turnLifecycle`) now owns every change of a turn, its session and its approval. Stopping a turn at an ask-first gate used to leave the approval pending, so it could be approved later and then wave through a later identical call; it is now closed with the turn. Finishing a turn that already ended is ignored, and a late reply-delivery result no longer rewrites a finished turn. Guardrail block patterns now hold streamed text until the finished reply passes, on the console and the public chat. Path protection covers every tool with a path argument, not only `write` and `edit`; `bash` is not path-confined, so the editor warns about it and every `bash` call now always waits for approval, even when `ask_first` does not list it. Overlapping retry sweeps can no longer send a channel reply twice. A public-chat request with `Origin: null` or a malformed origin no longer throws. Reserved agent ids (`sessions`, `approvals`, `new`) are rejected wherever an id is parsed, not only when generated. `sf agents chat` exits non-zero when the stream closes without a result, and `sf agents restore` needs `--base` so its optimistic lock means something. The MCP tools `get_agent_session`, `approve_agent_action`, `deny_agent_action` and `stop_agent_session` now take the agent `id` and refuse a session that belongs to another agent.
- **Agent runtime sessions no longer pile up.** A Pi session and its isolated MCP processes are released after 30 idle minutes (`STAGEFLOW_AGENT_SESSION_IDLE_MINUTES`), when a turn is stopped, when the agent is archived, and when the Host stops.
- **Cheaper agent reads.** The agents directory is no longer re-read and re-hashed on every call: an unchanged tree costs a directory listing and a stat per file, and edits are still picked up.

### Added

- **Agents.** An agent is a YAML file (`agents/<id>.agent.yaml`) with instructions, a model, granted tools, ask-first approvals and limits. It answers in the console and on web chat, by email (AgentMail), iMessage, Slack or Telegram, or runs on a schedule, and every turn is traced (spans, cost, optional groundedness eval and OTLP export). The console has an Agents directory, an agent page with revisions, a session page with a run inspector (Steps, Waterfall, Messages, Logs, Configuration), and approvals in the Inbox. The same operations exist as `sf agents`, REST (`/api/agents`) and MCP tools. See [Agents](docs/agents.md).
- **Console secrets work in pipeline stages.** A stage can list a secret saved from Settings → Project MCP under `secrets:` so its `mcp:` servers can use `${NAME}`. The value fills MCP servers only; it is never put in the stage environment, and `sf validate` no longer rejects it as unknown.
- **Allow-lists for Slack and Telegram agents.** `channel.allow_from` accepts a Slack user id (`U02ABC1234`) and a Telegram `@username` besides emails, phone numbers, `@domain` and `*`. Before, only `*` worked on those two channels.
- **Desktop notification for agent approvals.** The Notifications setting that alerts you when a stage waits on you now also alerts you when an agent asks for approval.
- **One model list for every screen.** Stage, pipeline, Workshop, Settings and agent pickers now read the models of the providers you have connected, grouped by provider and searchable, through one catalog (`GET /api/models`). The Host asks each connected provider for its current list through Pi (OpenRouter's free models included) and falls back to Pi's built-in list when a provider is unreachable. `POST /api/models/refresh` and the picker's refresh button refetch. A model id no connected provider lists is still accepted and shows a "not in connected providers" warning; agent validation warns the same way. The default model comes from the same catalog: `stageflow.yaml` `model`, then the Settings Workshop model, then the first free model of a connected provider. Cursor models appear only when Cursor is connected.

- **Agents can use Stageflow's own tools.** One registry groups the MCP tools (discover, runs, gates, triggers, agents, pipeline authoring) with a risk level, and an agent definition grants groups or single tools under `tools.stageflow`. The console has a Stageflow tools section in the agent editor and turns on ask-first for everything that is not read-only. An agent can never grant a tool it does not hold, edit or archive itself, or decide its own approvals.
- **Granular permissions.** The agent editor shows files, shell and Stageflow tools as one grouped checkbox tree: tick a group to select its tools, or tick single tools. `tools.builtin_tools` (read, grep, find, ls, write, edit, bash) joins `tools.builtin` groups in the YAML; the saved form stays compact.
- Some Stageflow tools are operator-only and cannot be granted to an agent: answering gates, deciding feedback loops and approving agent actions. Destructive tools moved into their own groups (`runs.cleanup`, `agents.cleanup`), gates split into `gates.read` and `gates.decide`, a web-chat agent that can read sessions gets a warning, and a copied agent can no longer drop an ask-first its creator is bound by.
- **Agents answer on AgentMail and iMessage.** An agent has one `channel` (`connection_id` plus a sender allow-list) and a connection has one agent. The Host listens itself (AgentMail WebSocket, Spectrum stream), so no public URL is needed: replies stay in the email thread, mail loops are ignored, senders are rate limited, and a dropped stream reconnects and catches up. `limits.always_on` keeps one conversation going without a time or turn limit and retries a turn a restart cut off. The old `channels` list still loads. Adds the `agentmail` dependency. For iMessage the editor shows which number to text (the project's line, or the number Photon assigned to each allowed person) and warns about allowed phones that are not registered in Photon; `GET /api/agents/:id/channel/contact`.
- **A channel reply is part of the turn.** The turn only succeeds once the reply reaches the person: transient failures are retried (5 s, 30 s, 2 min), permanent ones and unknown outcomes fail the turn as `agent.reply_undelivered` with the reason, and the run page offers Resend and Mark as delivered. An unknown outcome is never resent on its own. Migration 014 adds `agent_deliveries`.
- **Sidebar grouped by job, plus an Agent sessions list.** Inbox is pinned on top; Activity holds Pipeline runs and Agent sessions, Build holds Pipelines, Agents, Tasks, Workshop and Catalog, and Connect holds Triggers and Connections. Agent sessions lists every agent's sessions in one place with agent, status and source filters, search, project-wide metrics and a live badge; `GET /api/agents/sessions` (optional `agent`, `status`, `source`, `q`, `cursor`, `limit`).
- **New pipeline opens the Workshop.** The old New pipeline form (directory, id, stage ids) is gone from the console, along with the unused legacy Pipelines and Tasks page code and the old New stage panel. The Workshop is reached from Pipelines (New pipeline, Open in Workshop) and no longer has a sidebar item. `POST /api/pipelines` is unchanged.
- **Add MCP servers from the console.** Settings → Project MCP has Add server (a stdio/http form, or Paste JSON from a server's docs), Edit, Remove and Check, so a Host with no `.mcp.json` (the Docker image) is no longer a dead end. Servers added there are saved under `$STAGEFLOW_HOME/mcp/.mcp.json` (survives rebuilds) and merged over the project `.mcp.json`; on a name clash the console entry wins. They work for agents, stages, preflight, validation and probes, but never for a repository checkout's own `.mcp.json`. Routes: `PUT/GET/DELETE /api/project-mcp/:name`, `POST /api/project-mcp/import`; `GET /api/project-mcp` rows now carry `origin` (`project` or `console`).
- **Remote MCP servers get the right fields.** The add form takes the command on one line (`npx -y @scope/server`), labels environment rows, and for a URL server offers Authorization (None, Bearer token, Custom headers) and the connection type (Automatic streamable HTTP with SSE fallback, or SSE only, `httpTransport: sse`). Paste JSON is the first tab and also accepts other tools' shapes (`serverUrl`, `httpUrl`, `type: sse | http | stdio`). A bearer token typed in is stored as a secret and the file keeps `Authorization: Bearer ${NAME}`.
- **Sign in to OAuth MCP servers from Settings.** A URL server that asks for browser sign-in (Notion, Linear, Atlassian and the like) shows "Needs sign-in" on Check; Sign in gives a link to open, then you paste back the address your browser ended on (it points at `localhost`, which a Docker or remote Host cannot receive). On a local Host the callback finishes it by itself. Tokens are stored encrypted under `$STAGEFLOW_HOME/agent/mcp-oauth-encrypted` with a Host key in `$STAGEFLOW_HOME/secrets/mcp-oauth.key` (or `PI_MCP_ADAPTER_OAUTH_FILE_KEY`), so no OS keyring is needed. Refresh is automatic; Sign out removes them. Signed-in servers work for agents and Check, not for pipeline stages (they run in a sealed agent dir); use a bearer token for stages. Routes: `GET/DELETE /api/project-mcp/:name/oauth`, `POST .../oauth/start`, `POST .../oauth/complete`.
- **MCP status on arrival, and a tool checklist in the agent editor.** Settings → Project MCP checks every server when it opens (three at a time), so each row shows Connected, Needs sign-in or the error without clicking Check. In the agent editor, an MCP server's tools are a checklist with descriptions (filter once there are many, Select all, Refresh) instead of typed names; if the server cannot be reached the typed field stays as a fallback. `GET /api/project-mcp/:name/tools` returns the tools the Host last saw; a successful probe now also returns `tools`.
- **MCP secrets stay out of the file.** A literal token in a server's env or headers is moved into a write-only store (`$STAGEFLOW_HOME/secrets/mcp-secrets.json`, mode 0600) and replaced with `${NAME}`. Stored values fill `${VAR}` (they win over Host env of the same name) and are never returned: `GET /api/mcp-secrets` lists names, which servers use them and whether each is set; `PUT/DELETE /api/mcp-secrets/:name`. Settings shows the placeholders each server needs with a value field.
- **Agent approvals show in the Inbox.** When an agent is paused on an ask-first tool, the Needs you tab lists it beside pipeline gates (longest-waiting first, tagged with the agent and tool). The focus pane shows what will run and has Approve and run / Deny (`1` / `3`) and Open session (`O`). The sidebar Inbox badge counts both.
- New MCP tools: `read_pipeline`, `create_pipeline`, `edit_pipeline`, `create_stage`, `edit_stage`, `create_task`, `edit_task` (author pipelines on disk with the Workshop's validation), `update_trigger`, `set_trigger_enabled`, `list_agent_sessions`, `stop_agent_session`, `archive_agent`.

### Changed

- **The Agents list shows how each agent is reached.** A Reach column gives the web chat link (open or copy), the channel provider and connection, or the schedule, so a chat, email or iMessage agent is obvious at a glance. It also shows all-time cost per agent and in total, Enabled / Disabled / Needs setup as clear pills, and the first tools and approvals with a View all dialog. Disabling an agent now asks first and says what will happen: new sessions, web chat and channel replies stop, a running turn finishes, and nothing is deleted.
- **One page header.** Agents, Connections, Pipelines, Tasks, Triggers, Catalog and the agent pages share one 56px header bar, and Settings content is centered. The run inspector drops the Flame graph and Span list tabs, which repeated what the Waterfall shows.
- `GET /api/models` and MCP `list_models` keep `models` and `entries`, and add `providers`, `default`, `fetchedAt` and `unlisted`. `models` no longer includes a baked-in list: it is the connected providers' models plus ids your pipelines already use.

### Security

- **MCP backend hardening.** MCP secrets resolve by who asks: a stage sees console secrets only for names it declared in `secrets:`; agents and Check fill `${NAME}` from console secrets and from Host env names listed in `STAGEFLOW_MCP_ENV_ALLOW`, never from arbitrary Host env, and a stored secret is no longer shadowed by Host env (`host: true` is replaced by a named scope). Server entries cannot use `${NAME}` for control-token or provider/cloud credential names unless allow-listed, `PI_MCP_ADAPTER_OAUTH_FILE_KEY` is never grantable, and `GET /api/mcp-secrets` `set` reflects only the console store and allow-list. URL servers cannot target link-local or cloud-metadata addresses (save, resolve, Check, OAuth); project `.mcp.json` entries get the same shape and URL checks. Tokens in URL query/userinfo and `--token=` style args move to the secrets store, `GET /api/project-mcp/:name` returns a masked config, and error text from Check and sign-in is scrubbed. A corrupt host `.mcp.json` or secrets file now answers `409` instead of reading as empty, saves restore the secrets file if the catalog write fails, state files are written atomically (dir `0700`, files `0600`), and the OAuth key file is created without a half-written window. Malformed percent-encoding in `/api/project-mcp/*` and `/api/mcp-secrets/*` returns `400`; OAuth status/delete/complete reject unknown servers and `complete` rejects input that is not a URL or code.

## [0.36.0] - 2026-10-14

### Added

- **Communication channels (send-only).** Connect AgentMail, Slack, Telegram, iMessage or WhatsApp once, then let a stage send through it. A stage (or a pipeline default) declares `channels:` with the recipient pinned in YAML, and the agent gets one neutral `send_message` tool on the Pi backend. It cannot choose a recipient. iMessage and WhatsApp go through Photon and use optional `@spectrum-ts/*` packages. A stage uses one channel for now (enforced when a stage is parsed, merged, validated and sent; the code that supports several stays behind one limit). Receiving messages and agent channels are not part of this release. See [Communication channels](docs/channels.md).
- **Connections page.** Connect a provider from the console: Test connection before saving, Replace key, disable, disconnect, and a per-connection page with a status fix hint and a `channels:` snippet. First run explains that nothing is connected and offers every provider. Email accounts and `.mcp.json` tool servers are listed alongside. New `GET`/`POST /api/connections`, `POST /api/connections/test`, `PATCH`/`DELETE /api/connections/{id}`, `POST /api/connections/{id}/check` and `POST /api/connections/{id}/validate-target`.
- **Stage channels in the pipeline editor.** The stage inspector has a Channels section: pick a connection, enter a provider-shaped recipient with live validation, see the connection's status. Pipeline-level `channels:` now survives a draft save.
- **Host-level connections and a secret store.** Connections live in `$STAGEFLOW_HOME/connections.yaml` and are shared by every project (a project-root file wins; `STAGEFLOW_CONNECTIONS_FILE` overrides). Secrets are `env:NAME` references or `store:NAME` references to `channel-secrets.json` (mode `0600`) written by the console. A YAML value is never a secret.
- **Run-start channel check.** Preflight, `start_run` and `sf doctor` check each connection live and block the run with `channel_check_failed`, naming the connection and the reason. Only transient failures are retried, at most twice.
- **Safe sending.** Sends are idempotent per operation key through a durable ledger; a send that may have reached the provider is never resent, even after a restart. Secrets stay out of the stage worker, logs, errors and API responses.
- `examples/channels-smoke/`: a two-stage pipeline that sends one email and one text.

### Changed

- The Claude agent backend rejects a stage that declares `channels:` instead of running without `send_message`.
- The Docker image includes the optional Spectrum packages (about 100 MB); `npm install --omit=optional` skips them and iMessage/WhatsApp then report `CHANNEL_PROVIDER_UNSUPPORTED`.

### Known limits

- A Free or Pro Photon user must be a project user and must text their assigned Photon line once before iMessage sends are accepted. The run-start check cannot detect this.
- `sf backup` does not include `connections.yaml` or `channel-secrets.json`.
- Not verified against a real account: Slack, Telegram and WhatsApp sends.

## [0.35.0] - 2026-10-13

### Added

- **Operator console.** Inbox, pipelines list, pipeline editor (live DAG, inspector, YAML, Problems, session history), catalog, tasks, triggers, Workshop, and run detail (timeline / graph / list) are the console. There is no second UI and no theme picker; the console is dark.
- **Workspace catalog as the default write root.** Omitted `project_root` resolves to a Host-provisioned writable workspace under `$STAGEFLOW_HOME`, so Workshop and catalog saves work without a git checkout or multi-root picker.
- **Catalog paste-install for skills.** Install a skill tree into the workspace `.pi/skills` root from the Catalog UI (`npx skills add` wrapper), without requiring a project_root when the Host has multiple roots.
- **Stage-file editor from Catalog.** Edit a single external stage file in the full pipeline editor chrome (graph + inspector + YAML).
- **Triggers readiness catalog.** `examples/triggers-readiness/` ships one trigger per kind (manual, schedule, GitHub pull request, webhook, email, dynamic manual) and is registered in the local Docker image.

### Changed

- **Breaking: stage `skill:` is body-only.** `skill:` on a pipeline `uses:` wrapper is rejected (`pipeline.stage_wrapper_skill_rejected`). Put `skill:` on the external stage file or inline stage body. The console inspector and draft overwrite strip wrapper `skill`. In-repo examples (`archify-on-pr`, `oss-issue-contribution`) were migrated. See [Skill binding](docs/yaml-catalog.md#skill-binding).
- **Credential root separate from run data.** Stage workers and Workshop resolve provider auth from `STAGEFLOW_CREDENTIAL_HOME` (default `~/.stageflow`); run SQLite stays under `$STAGEFLOW_HOME`. Cursor models use the credential-root key; other models still require a usable `auth.json` there and fail closed.
- **Docker console image.** The image does not bake the full `examples/` tree. Compose registers `/opt/stageflow/catalog/triggers-readiness` so the readiness triggers are listed on a local Host.

### Fixed

- Workshop saves use `.pipeline.yaml` / `.task.yaml`, re-pin build ties to the catalog save root, and stop claiming paths under a stale image-root examples tree.
- `createStage` persists `skill` on the stage file; draft load/overwrite hoists legacy wrapper `skill` onto the stage body so save cannot drop the binding.
- Workshop mutation cards survive a reload because the transcript stores the draft, not only the summary.
- Run detail header and the stage inspector share one rule for showing Retry, Resume, and Abandon.

## [0.34.0] - 2026-10-07

### Added

- **Live view for human login gates.** When a Host has no window an operator can see, the console shows the stage's browser inside the login gate and forwards mouse, keyboard, paste and touch input to it, so a person can log in (password, two-factor code, popup sign-ins) from the console. It uses agent-browser's built-in stream relayed by the Host; no new dependency. See `docs/browser.md` (Live view) and `docs/browser-internals.md`.
  - The gate handoff is now capability-driven: `local_window` on a desktop, `live_view` (a stable path, never a credential) on a Host with a virtual display or headless-only with the relay. A Host with no screen and no live view still fails the login stage early.
  - Console API under `/api/runs/:run/stages/:stage/live-view`: single-use, short-lived tickets (`view` or `control`) redeemed into a path-scoped cookie, an event stream, ordered input, and a dialog answer route. Control works only while the stage waits at a live view gate and is revoked when the gate is answered, abandoned or cancelled. Input and frames are never logged or stored.
  - Popups and new tabs are followed automatically; `confirm` and `prompt` dialogs can be answered in the viewer; `alert` and `beforeunload` are handled by agent-browser. Unanswered dialogs are dismissed after `browser.dialog_timeout_seconds` (default 60).
  - "Reopen browser tab" fallback in the viewer's "Page seems stuck?" section (`POST .../live-view/reopen-tab`, relay `reopenTab()`): replaces a tab that stopped accepting input with a fresh one at the same URL in the same browser, moves the stage session and stream to it, then closes the old tab.
  - Virtual display support: a Linux Host without a display but with `Xvfb` runs the browser headed. Host config keys `browser.launch_args` and `browser.executable_path` (never in YAML) for launch options and distribution Chromium on ARM.
  - `docker/Dockerfile.browser` recipe that extends the runtime image with Chromium, Xvfb and agent-browser (`docs/docker.md`).
  - Provider-neutral ports with in-tree fakes (browser host capabilities, sandbox orchestrator, live view relay, live view source) as seams for container and provider browser hosts.
  - Opt-in smokes: `STAGEFLOW_BROWSER_SMOKE=1` (real Chrome, console API, popups, dialogs) and `STAGEFLOW_DOCKER_SMOKE=1` (browser recipe image).

### Changed

- Browser permission prompts (camera, microphone, location, notifications, clipboard) are denied by default for every browser session the Host launches (`--deny-permission-prompts`).
- Browser teardown first closes any live view for the stage or run (bounded wait), then runs the existing tab, session and anchor order.

## [0.33.0] - 2026-10-07

### Added

- Public hosted runtime for embedding one repository-free pipeline. `createHostedRuntime` accepts the existing Pi `StagePort` from `createPiStagePort()`, a local run store, and a `HostedEventSink`, then runs inline and returns a structured result and execution receipt. `configurePiProviderApiKey` stores a managed OpenRouter key in the Pi auth file that adapter already reads. Package skills at `.pi/skills/<name>/` are materialized for that run; operator-home skills are not loaded. See [Hosted runtime](docs/hosted.md).
- Package-root `exports` so consumers can `import { createHostedRuntime } from "stageflow"`.

### Changed

- A hosted run does not create the operator home. Stage credentials resolve from `STAGEFLOW_AGENT_AUTH_PATH` when set, otherwise from a path next to the local store.

## [0.32.0] - 2026-10-06

### Added

- Host-owned email connections to existing IMAP/SMTP mailboxes, configured through workspace `email.yaml`, with scoped stage tools for sending, replying, retrieving, searching, and handling bounded attachments.
- Durable incoming-email detection and filtered pipeline triggers, with bounded retry queues, historical-message replay, and optional Sent-folder copies.
- A read-only Connections page listing configured email accounts without credentials, and email-rule list and detail views on the Triggers page.
- Single-stage email-send and conversational threaded-reply examples, including automatic-reply safeguards.

### Changed

- Inline mailbox passwords from local YAML stay in Host memory; persisted account configuration contains opaque credential references.
- Email list-limit tests use a small mailbox instead of bulk network fetches. The clock-sensitive schedule catch-up test is temporarily skipped pending a deterministic timing check.

## [0.30.0] - 2026-10-04

### Added

- Workshop Author on `#/workshop`: a chat agent that drafts a pipeline, asks when a missing detail would change the stages or the wiring, and shows the draft on the studio stage map. Click a stage for its prompt, IO, verify, and HITL summary.
- Untitled drafts persist as build records under `$STAGEFLOW_HOME/workshop/builds/{id}.json` (no catalog file until save). Chat history persists separately under `workshop/sessions`, and each session points at the build it was editing.
- Author tools to list, focus, and create builds; create and edit the pipeline, stages, and an optional task; validate the draft; and save. Save writes catalog YAML only when asked, and refuses an invalid package unless the operator explicitly allows it. A save that does not name a folder lands in `workshop/<pipeline-id>`, and that folder is added to the catalog so Run lists the pipeline and task.
- Studio picker lists each open build and each on-disk pipeline once. The same chat can switch builds, or History can reopen the session that last edited another pipeline.
- `sf init` includes `workshop` in the pipeline and task catalog. Host boot registers the project root so that catalog is visible without a manual project add.

### Changed

- Workshop chat opens on the `model` in `stageflow.yaml`. When that is unset, the default is `openrouter/nvidia/nemotron-3.5-lightning:free`.

### Fixed

- `npm run dev` stage workers load the TypeScript CLI through tsx. They no longer exit looking for a missing `src/cli.js`.
- A stage process that exits before it can record a failure is marked failed, instead of leaving later stages skipped with the entry still pending.
- Cursor models find `pi-cursor-sdk` from the Host Pi agent directory. The stage worker's attempt `HOME` no longer hides `~/.pi/agent`.

## [0.29.0] - 2026-10-03

### Added

- **Browser sessions.** A stage can drive a real browser that stays logged in. The browser tool is [agent-browser](https://github.com/vercel-labs/agent-browser), used through the CLI and a bundled `browser` skill (no MCP). See `docs/browser.md` (users) and `docs/browser-internals.md` (contributors and agents).
  - Stage `browser` field: `profile`, `headed`, `allow_domains`, `login_url`, `check` (`url`, `logged_in_url`, `logged_out_url`). The `agent-browser` requirement is added automatically.
  - Profiles: named, saved logins kept on the Host under `$STAGEFLOW_HOME/browser/<scope>/<name>/` with owner-only permissions. A profile is leased to one run. Other runs queue until that run ends.
  - Shared browser per run and profile: the Host starts one Chrome and keeps it open for the whole run. Each stage attaches over CDP with pin-tab and gets its own tab, so parallel stages share one login. The Host closes each stage's tab at stage end and the browser at run end, cancel, or abandon. An orphan sweep runs at Host start.
  - Host-computed login check: `{ logged_in, url }` is computed by the Host and validated against the stage envelope. Human login stage: `verify: browser_login` with a confirm gate. The gate payload carries `handoff`, `site`, and `profile`. A wrong confirm returns `{ ok: true, verification: "failed_retrying" }` and raises a new gate while repair attempts remain.
  - `sf browser profiles | status | check | login | clear`.
  - Host config `browser.blocked_sites`, a per-Host audit log (`browser/audit.jsonl`), redaction of cookie and token output for browser stages, and owner-scope seams (`ProfileStore`, `ProfileLock`, `BrowserHost`, `KeyProvider`, `AuditSink`) for a future multi-tenant service.
  - Example `examples/browser-session/` (local fixture login server, two parallel work stages) and an opt-in real-Chrome smoke test (`STAGEFLOW_BROWSER_SMOKE=1`).
- Answer responses (HTTP 202 body, MCP `answer_gate`, `sf runs answer --json`) may include an optional `verification` field.

### Changed

- Stage workers receive the Host's Pi auth path through `STAGEFLOW_PI_HOME_AUTH_PATH`.

### Fixed

- Stages failed with "No API key" under the `pi_home` credential source, because the worker's empty attempt `$HOME` hid `~/.pi/agent/auth.json`.

### Known limitations

- Profile stages use a soft `allow_domains` check (agent-browser rejects its native allowlist with a profile or CDP). Profile-less stages get the native allowlist.
- The agent-browser key does not protect the Chrome profile folder and is not wired. A visible login window needs a screen; Docker Hosts fail the login stage with a clear message. Only macOS with agent-browser 0.38.2 was verified. The full list is in `docs/browser-internals.md`.

## [0.28.1] - 2026-09-30

### Fixed

- Project root resolution no longer requires git. `resolveStageflowContext` now finds the nearest `stageflow.yaml` first (like a `package.json` for npm), the same way for catalog discovery, trigger-adapter discovery, and stage/pipeline/trigger creation. `isGitProject` is still reported and still gates anything that genuinely needs git (checkout, worktrees), but no longer blocks reading or writing a catalog that has no git repo behind it. Previously, none of the three trigger adapters (schedule, GitHub poll, email) could discover triggers in a non-git catalog root at all.

## [0.28.0] - 2026-09-30

### Added

- Pipeline trigger and scheduler backbone: `kind: event` / `kind: schedule` trigger YAML, `TriggerSourcePort` adapter seam, and dynamic task mode (a firing event can build a one-off `TaskFile` instead of requiring a pre-authored task).
- Three trigger adapters, each a real `TriggerSourcePort` implementation: a GitHub poll connector (ETag-conditional, grouped by repo so N triggers on one repo cost one API call), a generic webhook adapter (per-trigger URL, HMAC-SHA256 verified), and an email connector (IMAP IDLE, connections pooled per mailbox, bounded-backoff reconnect).
- Generic `trigger_adapter_state` store table for adapter-persisted cursors (ETags, UID watermarks) shared across all three adapters.

### Fixed

- `event.config` was silently dropped on trigger creation (both HTTP and MCP); it now passes through opaquely to adapters.
- `STAGEFLOW_GITHUB_POLL_INTERVAL_MS` and `STAGEFLOW_TRIGGER_TICK_INTERVAL_MS` are now recognized Host env keys; setting either to tune an adapter's interval no longer crashes boot.
- The GitHub poll adapter no longer logs an error on every "nothing changed since last poll" tick — Octokit throws on HTTP 304, which was being caught and logged as a failure instead of handled as the expected no-op.

## [0.27.1] - 2026-09-26

### Fixed

- Registered catalog roots with a local `stageflow.yaml` now list pipelines/tasks without requiring git, so MCP/HTTP discovery matches `start_run` / validate for non-git projects.
- Cold Host seeded `examples` browse via `examples/stageflow.yaml` (symbolic `project_root: "examples"`).
- Empty catalog lists return a registration tip; absolute-path rejections keep the ban but include richer relative-path / CLI-ensure guidance.
- Unset `TMPDIR` / `TMP` / `TEMP` soft-defaults to `$STAGEFLOW_HOME/tmp` before the Host writability assert.
- HTTP health exposes `boot_providers` (and clarified live provider summary); MCP `get_health` includes `stageflow_home`.
- `sf init` / author defaults prefer a configured provider (or a loud placeholder) instead of silently assuming Anthropic.

### Changed

- **BREAKING:** Omitting `gate_kinds` no longer registers `ask_operator`. Only an explicit non-empty `gate_kinds` list registers the tool (kinds allowlist as before). `gate_kinds: []` remains explicit off. Stages that relied on omit-means-on must declare kinds. See `docs/hitl.md` and `docs/yaml-catalog.md`.
- Quickstart and setup skill split CLI smoke vs MCP smoke (Host + register + catalog-relative paths); docs contrast `STAGEFLOW_OPERATOR_CWD` (skills) vs catalog `project_root`.

## [0.27.0] - 2026-09-25

### Added

- Container image delivery (Slot 10): multi-stage `Dockerfile` (digest-pinned Node 22 slim, non-root `10001`, tini + `sf mcp`, `HEALTHCHECK` on `/livez`, toolchain at `/etc/stageflow/toolchain.json`); root `docker-compose.yml` for local try; `scripts/docker-smoke.sh` + CI job; GHCR multi-arch publish + cosign keyless sign-by-digest on the npm version gate. See `docs/docker.md`.
- `sf doctor` `store_integrity` check runs full `PRAGMA integrity_check` (boot/readyz stay on `quick_check`).
- `sf validate` flags absolute paths under `$STAGEFLOW_HOME` in stage prompts and verify commands (`catalog.stageflow_home_absolute_path`).

### Fixed

- `STAGEFLOW_BUILD_SHA` is an allowed Host env (image provenance / `/api/health` `build_sha`) so container boot no longer rejects the Dockerfile-baked value.
- Bound-run Pi `read`/`write`/`edit` allow the stage `checkoutRoot` (still deny other durable-root paths such as `state.db`, `agent/`, sibling worktrees).
- Bare repo cache uses `git clone --bare` with remotes-style fetch (`+refs/heads/*:refs/remotes/origin/*` and `+refs/tags/*:refs/tags/*`, no `remote.origin.mirror`); existing mirrored or `+refs/*:refs/*` caches are healed under the cache lock, short refs resolve via remotes tips, and non-`stageflow/` local heads are pruned so linked-worktree `git push` keeps working.
- For `GITHUB_TOKEN` / `GH_TOKEN`, `{ as: env }` is additive with askpass: curated env keeps the value and `GIT_ASKPASS` + token file are still materialised for plain HTTPS git.
- When a repository-bound run reaches `succeeded`, Stageflow reclaims the Host worktree (keeps `run_branch`; leaves `checkout_root` recorded; does not set `slimmed_at`). Fail/cancel and mid-pipeline checkouts are unchanged; retry after succeed soft-fails `checkout_reclaimed` when the path is gone.

### Changed

- `docs/mcp.md` Limitations / CLI-only table refreshed to match shipped Slot 9 surfaces (`skills`, `export_run`, debug-bundle).
- Stage-env migration / YAML catalog docs clarify that GitHub `{ as: env }` keeps askpass for HTTPS git.
- Docker Local try docs rewritten as a Compose first-run checklist; add root `.env.example` and align `docker-compose.yml` with `STAGEFLOW_PROVIDER_*` boot keys.
- Harness skills suite updated for Compose local try, drive-token MCP calls, `$STAGEFLOW_HOME` run store, repository/`ref` binding, and Slot 6 `secrets:` authoring.

## [0.26.0] - 2026-09-24

### Added

- Host-global project registry under `$STAGEFLOW_HOME`: durable `ensure` of absolute project roots; `sf run` ensure-then-starts before `start_run`; remotes may only use registered ∪ seeded catalog roots (no invent of unknown absolute `project_root`; Host boot cwd is not a catalog root). See `docs/mcp.md`, `docs/cli-reference.md`, `docs/data-directory.md`.
- Curated stage environment (Slot 6): stages no longer inherit Host ambient env; declare `secrets:`; file-backed git askpass; value redaction; proxy/CA passthrough; shared `$STAGEFLOW_HOME/cache`; MCP connect default 30s; finite stage-process/heap caps; Claude-as-root refusal. See `docs/migration-stage-environment.md`.

### Changed

- Catalog start/write path selection is shared (`resolveCatalogStartInput` / `resolveWritableCatalogRoot`); MCP `run_stage` and A2A string stage paths honor the same catalog containment as `start_run`.
- Operator-terminal run statuses (`cancelled` / `queued`) are preserved inside `deriveStatusFromStages` so recovery and projection cannot overwrite them.
- Host shutdown drains through a required `DrainableHost` adapter (single drain path).
- Stage worker builds / preserves curated env explicitly (forked workers keep launcher-granted secrets; in-process path filters via `buildStageEnvironment`).
- Path-checkout lease (`busy_checkout`) applies only to path-bound runs. Repository-bound runs each get their own worktree and may run in parallel on the same repository; attach/resume no longer re-lease worktree paths.
- `verify` commands run under `bash -c` (not `/bin/sh`).
- Stage MCP `${VAR}` interpolation resolves against the curated stage env only.

### Removed

- Dead `RunStore.listProjectRoots` (superseded by `listRegisteredProjects`) and unused `isMutatingApi` predicate (superseded by `requiredScopeFor`).

## [0.25.0] - 2026-09-21

### Added

- `run_stage`: run a single stage directly, without authoring a pipeline — a catalog stage path or a bare inline stage body, exactly one of `task_path`/`task`/`envelope_ref` for input, optional `blocking`/`timeout_ms` for a single-round-trip result instead of poll, and a per-call `model` override. Internally synthesizes a one-stage pipeline and runs it through the exact same path `start_run` uses, so it gets the same persistence, `verify`/retry, and HITL behavior and is pollable with `wait_run`/`get_envelope` like any other run. Exposed identically as an MCP tool, a new `sf run-stage` CLI command (distinct from the existing internal-only `sf internal run-stage`), and a new A2A operation. See `docs/mcp.md#run_stage`, `docs/cli-reference.md#sf-run-stage`, `docs/a2a.md`.
- `envelope_ref`: chain a `run_stage` call off a previously stored `StageEnvelope` — from another `run_stage` call or from any stage inside a full pipeline run — instead of an inline task. Accepts either one reference or an array of them; multiple references are resolved and namespaced under their `stageId` in the next call's `input` (disambiguated by `runId` on a `stageId` collision), with summaries combined into `goal`.
- A2A's `run_stage` operation deliberately bypasses `a2a.yaml`'s `publications`/`allowed_callers` allowlist — any authenticated caller can run any catalog or inline stage/pipeline through it, the same wildcard-access default the MCP tool and CLI give a local harness. A temporary trade-off for proving out standalone stage execution, not a hardened access-control surface; existing `invoke`/`answer` and their allowlist enforcement are unchanged.

## [0.24.0] - 2026-09-20

### Added

- Inbound A2A: publish explicit pipelines as A2A capabilities that other agents invoke over JSON-RPC. Discovery via Agent Card and per-publication contracts, durable at-most-once run submission, invoke/poll/results, caller-answerable clarification gates, result freezing with opaque artifact downloads, per-caller rate limits and admission caps, and terminal-task/message retention. See `docs/a2a.md`.
- `a2a.yaml` is auto-discovered at the project root (next to `stageflow.yaml`) when `sf ui` starts -- no environment variable required. `STAGEFLOW_A2A_CONFIG` still works as an explicit override for a config living outside the project. `sf a2a validate`/`sf a2a list` follow the same discovery rule, with `--config` now optional on both.
- New `sf a2a add-caller <id>` command: generates a caller's token and writes its `id`/`token_env` name into `a2a.yaml` (scaffolding the file if it doesn't exist yet), printing the token to export -- never writes a secret value to disk.

## [0.23.0] - 2026-09-15

### Added

- Live output streaming for a running stage: assistant text is now captured as it streams, batched every ~300ms, redacted for secret-shaped substrings, and persisted to a small size-capped `stream.log` per stage attempt. New poll-based MCP tool `tail_stage_log` (`{ runId, stageId, attempt?, since_offset? }` → `{ text, next_offset, attempt_complete, truncated?, earliest_offset? }`) lets any watcher (the console, a host integration) follow along with a byte-offset cursor. Always on, no pipeline flag; purely additive — `log.jsonl`, `list_stage_events`, and `resources/subscribe` are unchanged.

## [0.22.0] - 2026-09-15

### Added

- `start_run`'s `pipeline` field now also accepts an inline pipeline definition object (`{ id, stages: [...] }`), not just a filesystem path — validated and executed through the exact same path a file-based pipeline uses, so a host integration can delegate a well-defined, typed task without first writing and saving a YAML file. No new tool, no stage-count limit, no special-cased single-stage mode. A run started this way has no `pipeline_path` and can't be `rerun` — save it to a file if you want that.

### Fixed

- MCP `start_run` now returns a structured `{ error, validation }` body on a pipeline validation failure, matching `POST /api/runs`, instead of an uncaught bare-string error

## [0.21.0] - 2026-09-15

### Added

- `get_health`'s MCP response now includes a `version` field, so a host integration can detect a behavior change that doesn't add or remove a whole tool
- New lightweight `get_waiting_summary` MCP tool — a cheap count/identity list of waiting stages (no prompt bodies, artifacts, or questions) for status-bar badges, scoped by optional `runId` or `path`, spanning every project by default
- MCP inspect parity with the operator console: read-only `list_providers`, `list_models`, `list_project_mcp`, and `probe_project_mcp` (no login, settings-write, or Stage MCP attach)
- `describe_pipeline` includes Clone Chain, feedback-loop, and inbound route `if`/`on` wiring so agents can inspect before `start_run`
- `read_artifact` returns PNG/JPEG/GIF/WebP as MCP image content blocks (text stays JSON; unknown binary still errors)
- Lean `get_run` / `wait_run` (and the run resource) pass through `total_cost_usd` and clone `definition_id` when present on the store
- `decide_feedback_loop` appends a durable `feedback_loop_decided` stage event with optional `reason` before succeeded/failed
- Optional `attempt` on `get_envelope` to read a prior execution's stored envelope (omit = latest)
- `examples/mcp-hitl-tour` walkthrough for MCP-first HITL (`answer_gate`) and feedback-loop decide

### Fixed

- Feedback-loop `wait_for_human` source passes persist as `waiting`, then `succeeded`/`failed` on continue/abandon, so `get_run` no longer leaves the pass `running`

## [0.20.0] - 2026-09-15

### Added

- Stageflow now runs as a single global, auto-starting service instead of one process per project — `sf run`/`sf runs *` talk to it over HTTP, and it starts itself on first use, so opening a second project or git worktree no longer collides on port binding

### Changed

- Run data lives in one shared `~/.stageflow` store instead of per-project `.stageflow/` directories — a run started from any project shows up in `sf runs list` from any other project too
- `maxConcurrent` is a global setting for the whole service, not per-project
- `--operator-cwd`/`--operator-agent-dir` on `sf run` no longer have any effect, since the shared service's operator catalog is fixed once at its own startup; set `STAGEFLOW_OPERATOR_CWD`/`STAGEFLOW_OPERATOR_AGENT_DIR` before the service first starts instead

## [0.19.0] - 2026-09-14

### Added

- Resume a timed-out failed stage on the same attempt from the CLI, MCP, and operator console
- Collapsible feedback-loop banner on the run map; collapsed by default except when waiting for a human decision

### Fixed

- Feedback-loop remints keep Join and scheduling on the active clone cohort and skip superseded instances
- Stringified JSON objects in `emit_stage_envelope` and `ask_operator` arguments are coerced before schema validation
- Operator console hides superseded Clone Chain instances from the spatial map

## [0.18.0] - 2026-09-12

### Added

- Clone Chains: a sealed emitter → clone child → Join path. N is the length of one named-`$ref` Clone Array; `clone_cap` and `clone_mode` sit on the emitter's pipeline entry; each Clone Instance receives that array element only
- Deterministic `if` on forward Route entries, and `type: loop` Route entries as current loop authoring

### Changed

- Pipeline wiring is `route` / `entry` only. Listed Route targets always run (no agent `fork_choice` pick list)

### Removed

- `clonable`, envelope `clone_forks`, and skip / once / fanout as current cloning
- `needs`, `fork`, and `feedback_loop` as current pipeline-stage fields

## [0.17.0] - 2026-09-10

### Added

- GitHub-Actions-style log panel on the run detail page, alongside the existing conversational transcript: every tool call, message, and lifecycle event renders as a collapsible step with a status indicator, human-readable label (e.g. `Read app.ts`, `Bash npm test`), duration, and a one-line preview of its result
- The step responsible for a stage failure auto-expands, with a pinned banner linking straight to it
- Either side of the transcript/logs split can be hidden independently; logs are shown by default
- `npm run dev:watch` — a live-reload local dev loop for the backend (paired with the existing `npm run ui:dev` for the frontend), so UI/backend changes no longer require a manual build + restart cycle

## [0.16.0] - 2026-09-10

### Added

- Per-stage and per-run LLM cost/token tracking, sourced from the Claude Agent SDK's and pi-ai's own per-turn accounting — no separate pricing table
- `stage_executions.cost_usd` / `usage_json`, summed across attempts into `StageSnapshot.cost_usd` and across stages into `RunSummary.total_cost_usd`
- `sf run` prints a `Cost:` line in human output and `total_cost_usd` in `--json`
- Cost badges in the UI on the runs list, run detail header, and each stage

### Fixed

- `claudeAdapter`: the interrupt-on-tool-result path could break out of the turn before the SDK's cost-bearing `result` message arrived, silently losing usage data on every successful Claude-backed stage

## [0.15.0] - 2026-09-10

### Added

- Target catalog dialect: `io`, `verify`, and `on_verify_fail` on pipelines and stages
- Dual-read of legacy `payload_schema`, `pre_emit_checks`, `completion`, and `recovery` onto the same IR
- `sf migrate-yaml` to rewrite a catalog onto the target spelling
- Optional task `input` checked against entry `io.input`
- Pipeline-root `schemas:` for `$ref`, with sequential `io` subset checks at load
- `sf run --json` optional `findings` (including `pipeline.model_applies` and `task.entry_input_unmet`)

### Changed

- Public docs and author skills teach `io` / `verify` / `on_verify_fail`; first-party examples convert to the target dialect

## [0.14.0] - 2026-09-09

### Added

- Optional `model` defaults on `stageflow.yaml` and `*.pipeline.yaml`; stages may omit `model` when a higher tier fills it
- Resolution at pipeline load: `stage.model ?? pipeline.model ?? stageflow.yaml model`, failing with `stage.missing_model` when unset (no silent hardcoded model)
- `LoadedStageConfig` / `materializeStageModels` so loaded stages carry a required effective model
- Operator console New Stage: inherit default model; blank custom “Other” is rejected
- Fixtures under `tests/fixtures/model-hierarchy/` and docs for model defaults vs `agent` backend selection

### Changed

- Invalid present `stageflow.yaml` fails pipeline load with catalog/manifest errors instead of being skipped as “no global model”
- Create stage/pipeline APIs reject empty/whitespace `model` instead of coercing to inherit

## [0.13.0] - 2026-09-09

### Added

- Stage `mcp:` allowlists from project `.mcp.json`, resolved and interpolated before the agent session opens
- Isolated Pi/Claude MCP attach so a stage only receives the servers it names; host MCP files stay out of the session
- Operator console Settings: list project MCP servers and Check connect without opening a stage
- `STAGEFLOW_STAGE_ARTIFACTS_DIR` stamped into MCP args and stage `system_prompt` so MCP tools can write into the attempt artifacts directory
- Image run artifacts (PNG/JPEG/GIF/WebP) served with the matching content type and rendered in the Files pane
- Walkthroughs: `examples/stage-mcp/`, `examples/playwright-mcp/`, and `examples/context7-mcp/`

### Fixed

- Settings Check uses eager MCP lifecycle so a cached Pi MCP metadata file is not treated as a live connect

## [0.12.1] - 2026-09-08

### Changed

- Harness `stageflow-author` documents run-derived anti-patterns as Always-do contracts (emit, artifacts, checkout writers, review remediation, completion wiring)
- `stage-prompt-template` and `catalog-mapping` harden prompts and DAG shape for those contracts; `stageflow-session-capture` catalog authoring matches the same emit/artifact/summary rules

## [0.12.0] - 2026-09-07

### Added

- `payload_schema` / `clone_input_schema` string constraints: `pattern` (JS RegExp, unicode), `minLength`, and `maxLength`
- `nullable: true` on nested schema nodes (compiles to a union with `null`; root object cannot be nullable)

### Changed

- Keywords `pattern`, `minLength`, `maxLength`, and `nullable` that were previously ignored are now enforced at compile/runtime

## [0.11.0] - 2026-09-07

### Added

- Generic multi-parent fan-in: a stage may `needs` two or more catalog parents; the join receives `priorEnvelopesByStage` keyed in YAML declaration order
- Structured `needs` items `{ id, on }` so a join can accept `succeeded`, `failed`, or `skipped` per parent without failing the run
- `examples/generic-fan-in/` walkthrough for the diamond join and the accepted-failure variant

## [0.10.0] - 2026-09-07

### Added

- Claude Agent SDK backend as an alternative to Pi for stage execution, selected via `agent: claude` in `stageflow.yml` at global, pipeline, or gated stage scope
- HITL parity for the Claude backend: non-blocking `ask_operator` handling with session-marker-based resume, matching Pi's wait/answer lifecycle
- Parameterized `StagePort` contract tests covering both backends

## [0.9.0] - 2026-09-02

### Added

- `sf --version` / `sf -V` print the package version without opening a catalog or run store
- `sf runs` host-down operator verbs: `list`, `show`, `waiting`, `wait`, `answer`, `retry`, `abandon`, `rerun`

### Changed

- Harness `stageflow-run` answers HITL on a down host with `sf runs waiting` / `answer` / `wait` instead of starting a disposable `sf mcp --mcp-stateless` bridge
- Harness `stageflow-run` presents mappable HITL gates on the host native question UI when one exists, and still submits through `answer_gate`. A representable `multi_question` is one picker call, not sequential cards.
- Public docs catch up to the 0.8 console (spatial map, gated workspace, stage deep links), full-catalog task validation, MCP via `sf mcp`, and YAML wiring vs body / clone-join contracts

### Fixed

- GitHub Release notes include every CHANGELOG version since the last published GitHub Release, not only the latest package.json bump
- Manual **Repair GitHub Release notes** workflow rewrites published GitHub Release notes from CHANGELOG when a version gap was missed

## [0.8.0] - 2026-09-01

### Added

- Spatial map-first run detail page: zoomable stage graph, gated workspace (logs / files / envelopes / HITL), and stage deep links (`#/runs/:id/stages/:stageId`)

### Changed

- Runs and Pipelines list rows stack identity above a full-width mini track so catalog paths stay readable
- Created runs show `not started` (still gray status) and a `Start run` primary action until history exists

### Fixed

- Run-page polish: workspace header wrap, single envelope/artifact chrome, camera refit when the workspace opens, readable node Retry/Abandon icons, focus rings, clone-aware aside labels, and quieter failure/turn transcript dividers

## [0.7.0] - 2026-09-01

### Changed

- **BREAKING:** Parallel clone join requires every clone to succeed. A clone failure skips the join and its descendants; sibling clones still run. Sequential fail-fast is unchanged.

### Fixed

- Cursor provider resolution prefers `pi-cursor-sdk` `dist/index.js` (0.3+) over `src/index.ts`, so parallel Cursor stages load the isolated per-session store.

## [0.6.0] - 2026-08-31

### Added

- Rich MCP operator surface: `validate`, `describe_pipeline`, `list_waiting`, `retry_stage`, `abandon_stage`, `rerun`, plus catalog/control parity with the console
- `wait_run` long-poll for agent observation (`until=any|waiting|terminal`) with progress notifications
- Session-backed MCP by default, `stageflow://runs/{runId}` resources, and `sf mcp` standalone host
- Shared `createHttpHost` for `sf ui` and `sf mcp` (`/mcp`, `requestTimeout=0`, Origin checks)

### Changed

- **BREAKING (MCP):** sessions are the default transport mode (`--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` for opt-out)
- **BREAKING (MCP):** `list_pipelines` / `list_tasks` return `{path,id}` objects instead of path strings (greenfield; no prior MCP clients)

## [0.5.0] - 2026-08-28

### Added

- Clonable successors: pipeline `clonable` / `clone_cap` and envelope `clone_forks` (`skip` | `once` | `fanout`) so a completing stage can clone one successor N times, then join
- Parallel clone join receives every clone envelope (including failures); sequential clones fail-fast
- Fan-out instance ids (`{catalogId}~{n}`) in the run store, CLI `--stage`, console, and MCP
- Operator console clone tracks and HITL on a selected clone instance
- `examples/clonable-fanout/` walkthrough (skip / once / parallel / sequential / mix)

## [0.4.0] - 2026-08-27

### Added

- CI headless run access: `sf run --json --include stages`, `sf envelope get` (`envelope` / `handoff` formats), `sf export-run`, `sf artifact read`
- `sf skills list` / `sf skills install` (`--from-path`, `--from-zip`) for provisioning Pi skills in CI
- Pipeline stage entry `skill:` binding (resolved at stage start; missing skill fails the stage)
- `.github/actions/sf-run` composite for run + optional handoff extraction + export
- `examples/archify-on-pr/` — PR diagram automation dogfood (conditional fork, Archify skill, GHA deliver)
- `scripts/prepare-ci-context.sh` and `scripts/deliver-diagrams.sh` for deterministic CI context and Archify deliver
- Fork-skipped stages persist as `skipped` in the run store and appear correctly in CLI/MCP projections

### Fixed

- Architecture deliver no longer pins evidence to the ephemeral `pull_request` merge commit (`GITHUB_SHA`); uses PR head SHA via `ci-context.json`

## [0.3.0] - 2026-08-26

### Added

- Conditional stage routing: pipeline `fork` field (`select: one | subset`, optional `allow_none`) and envelope `fork_choice`; unchosen branches and descendants are `skipped`
- Repo-root `stageflow.yaml` manifest and `sf init` scaffold
- Git-root `.stageflow` run store; global auth under `~/.stageflow` by default

### Changed

- **BREAKING:** Pipeline-owned catalog replaces legacy `pipelines/` + `stages/` + cwd layout. Stages are object entries with `uses:` or inline bodies; filenames use `*.pipeline.yaml` / `*.task.yaml`.
- **BREAKING:** `--pipeline` requires a filesystem path (no bare pipeline id).
- **BREAKING:** MCP `start_run` requires a pipeline path.
- **BREAKING:** MCP `list_pipelines` and `list_tasks` return manifest filesystem paths, not bare ids.
- Migrated repo fixtures, examples, docs, and CI workflows to pipeline-owned paths.

See `docs/yaml-catalog.md` and `docs/quickstart.md` for the pipeline-owned authoring model.

## [0.2.0] - 2026-08-25

### Added

- Headless CI guest contract: `sf run --json` with exit codes `0` / `1` / `2`
- `--skip-gates` flag to fail HITL stages instead of parking
- Optional CI identity stamped on run creation
- Unified guest module for run start and completion reporting
- GitHub Release pipeline dogfooding via Stageflow stages

### Changed

- HITL park reports `waiting` outcome (exit `2`) instead of success
- Busy start remapped to exit `1`

### Fixed

- `sf` bin resolves main correctly when installed as a symlink

## [0.1.0] - 2026-08-24

### Added

- Initial public release: YAML catalog (pipelines, stages, tasks)
- Pi-native stage worker with fresh session per stage
- Typed envelope handoffs and stage artifacts
- Operator console (`sf ui`) with HITL gate replies
- MCP Streamable HTTP endpoint at `/mcp`
- SQLite run store under `.stageflow/`
- `sf validate`, `sf providers`, parallel pipeline DAG support

[Unreleased]: https://github.com/tejasghutukade/stageflow/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/tejasghutukade/stageflow/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/tejasghutukade/stageflow/compare/v0.17.0...v0.18.0
[0.15.0]: https://github.com/tejasghutukade/stageflow/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/tejasghutukade/stageflow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/tejasghutukade/stageflow/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/tejasghutukade/stageflow/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/tejasghutukade/stageflow/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/tejasghutukade/stageflow/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/tejasghutukade/stageflow/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/tejasghutukade/stageflow/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/tejasghutukade/stageflow/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tejasghutukade/stageflow/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/tejasghutukade/stageflow/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tejasghutukade/stageflow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tejasghutukade/stageflow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tejasghutukade/stageflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tejasghutukade/stageflow/compare/a30b7b4...v0.2.0
[0.1.0]: https://github.com/tejasghutukade/stageflow/commit/a30b7b4
