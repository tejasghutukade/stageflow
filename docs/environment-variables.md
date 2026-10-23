# Environment variables

Every variable the Host and CLI read, in one place. Details live in the page each row links to.

**Boot check.** At start the Host refuses any `STAGEFLOW_*` variable it does not know (`config_unknown_key`), so a typo cannot silently do nothing. `STAGEFLOW_ALLOW_UNKNOWN_CONFIG=1` turns that into a warning. The known list is `KNOWN_STAGEFLOW_ENV_KEYS` in `src/config/hostConfig.ts`, plus the prefixes `STAGEFLOW_PROVIDER_`, `STAGEFLOW_SLIM_`, `STAGEFLOW_PURGE_` and `STAGEFLOW_CONTROL_TOKEN_`. Precedence for settings that also exist in `config.yaml`: CLI flag, then environment, then file, then default.

**Empty values.** An empty variable is treated as set for numeric agent settings: `STAGEFLOW_AGENT_SESSION_IDLE_MINUTES=""` and `STAGEFLOW_AGENT_STALL_SECONDS=""` both parse as `0`, which switches the idle release and the stall watchdog **off**. Leave them unset to get the defaults; do not pass them through Compose as `${VAR:-}`.

## Host and network

| Variable | Purpose |
|----------|---------|
| `STAGEFLOW_HOME` | Host state directory (default `~/.stageflow`; `/data` in Docker). See [Data directory](data-directory.md) |
| `STAGEFLOW_CREDENTIAL_HOME` | Where provider auth and `channel-secrets.json` live (default `~/.stageflow`) |
| `STAGEFLOW_CONNECTIONS_FILE` | Overrides the `connections.yaml` location. See [Channels](channels.md#connectionsyaml) |
| `STAGEFLOW_BIND` | Listen address for `sf ui` / `sf mcp` |
| `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND` | `1` allows a non-loopback bind with no control token (local Compose only) |
| `STAGEFLOW_ALLOWED_HOSTS` | Extra Host/Origin names accepted (loopback always allowed; `*` rejected). Needed for any public hostname, including webhook and web chat URLs |
| `STAGEFLOW_CONTROL_TOKEN`, `_FILE` | Drive-scoped bearer token (32+ chars) |
| `STAGEFLOW_CONTROL_TOKEN_<NAME>`, `_FILE` | Named drive token |
| `STAGEFLOW_READ_TOKEN`, `_FILE` | Read-scoped bearer token |
| `STAGEFLOW_SERVICE_PORT` | Port of the shared global service (tests only) |
| `STAGEFLOW_NO_AUTOSTART` | Do not start the Host from CLI verbs (containers) |
| `STAGEFLOW_AUTOSTART_TIMEOUT_MS` | How long the CLI waits for an autostarted Host (default 10000) |
| `STAGEFLOW_NO_OPEN` | Do not open a browser for `sf ui` |
| `STAGEFLOW_REQUEST_TIMEOUT_MS` | HTTP request receive timeout (default 60000) |
| `STAGEFLOW_MAX_CONNECTIONS` | `server.maxConnections` (default 256) |
| `STAGEFLOW_SHUTDOWN_GRACE_MS` | SIGTERM drain budget (default 8000) |
| `STAGEFLOW_MCP_STATELESS` | Disable MCP sessions (tests/debug) |
| `STAGEFLOW_ALLOW_UNKNOWN_CONFIG` | Warn instead of failing on unknown `STAGEFLOW_*` variables or config keys |
| `STAGEFLOW_BUILD_SHA` | Commit surfaced on health and `--version --json` |
| `STAGEFLOW_IMAGE_DIGEST` | Image digest recorded in run manifests |
| `STAGEFLOW_IN_DOCKER` | `1` marks a container for browser human-login hints |
| `STAGEFLOW_LOG_FORMAT`, `STAGEFLOW_LOG_LEVEL`, `STAGEFLOW_LOG_MAX_LINE_BYTES` | Host logging. See [CLI reference](cli-reference.md#environment-variables-selected) |

## Runs, stages and storage

| Variable | Purpose |
|----------|---------|
| `STAGEFLOW_MAX_CONCURRENT_RUNS`, `_PER_PROJECT`, `STAGEFLOW_MAX_QUEUED` | Admission. See [CI](ci.md#concurrency-env-vars) |
| `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN`, `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` | Stage concurrency caps |
| `STAGEFLOW_STAGE_EXECUTION` | `process` (default) or `inprocess` |
| `STAGEFLOW_STAGE_CONTAINER_IMAGE` | Image for the per-attempt sandbox. When set, `read`, `write`, `edit`, and `bash` run in that container. Unset keeps those tools on the host |
| `STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN` | Docker client used to start that sandbox (default `docker`) |
| `STAGEFLOW_STAGE_ENV_ALLOW`, `STAGEFLOW_STAGE_ENV_PASSTHROUGH` | Extend the curated stage environment. See [Stage environment](migration-stage-environment.md) |
| `STAGEFLOW_SECRET_REGISTRY` | Comma list of Host env names stages may declare under `secrets:` |
| `STAGEFLOW_REQUIRE_PROVIDERS` | Providers that must be configured at boot |
| `STAGEFLOW_PROVIDER_<NAME>_…` | Provider credentials. See [Providers](providers.md) |
| `STAGEFLOW_AUTO_RESUME_INTERRUPTED`, `STAGEFLOW_MAX_AUTO_RESUMES` | Boot auto-resume of interrupted stages (off by default; cap 3) |
| `STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS` | How long a retry waits for the root run to settle |
| `STAGEFLOW_RUN_BRANCH_TEMPLATE` | Branch name template for repository-bound runs |
| `STAGEFLOW_GIT_AUTHOR_NAME`, `_EMAIL`, `STAGEFLOW_GIT_COMMITTER_NAME`, `_EMAIL` | Identity for commits made in run workspaces |
| `STAGEFLOW_ENSURE_PROJECT_ROOTS` | Comma list of project roots to register at boot |
| `STAGEFLOW_TOOLCHAIN_MANIFEST` | Path to the toolchain manifest used by preflight |
| `STAGEFLOW_LEGACY_YAML` | `0` rejects legacy authoring keys |
| `STAGEFLOW_ACTIVITY_TEXT_LIMIT`, `STAGEFLOW_ACTIVITY_VERBOSE` | Transcript truncation and verbosity |
| `STAGEFLOW_EVALS_KEEP_WORKDIR` | `1` keeps the eval engine's work directory (`$STAGEFLOW_HOME/eval-runs/<evalRunId>/`: generated config, results, logs) after a run, for debugging. Otherwise it is removed when the run ends. See [Evals](evals.md#troubleshooting) |
| `STAGEFLOW_EVALS_SMOKE` | Test only, not read by the Host: `1` enables the opt-in real-engine test `tests/evals.promptfoo.smoke.test.ts` (needs the engine installed and network access). See [Evals](evals.md#the-engine) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Judge key for rubric graders when the credential file has no `api_key` entry for that provider. See [Evals: Judge models](evals.md#judge-models) |
| `STAGEFLOW_GC_INTERVAL_MS` | Garbage-collection interval (default 1 h, `0` disables) |
| `STAGEFLOW_BARE_CACHE_TTL_MS`, `STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES`, `STAGEFLOW_SLIM_*`, `STAGEFLOW_PURGE_*` | Retention knobs |
| `STAGEFLOW_DISK_WARN_BYTES`, `STAGEFLOW_MIN_FREE_DISK_BYTES` | Free-disk warning and admission floor (bytes or `N%`) |
| `STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS`, `STAGEFLOW_SQLITE_SYNCHRONOUS`, `STAGEFLOW_SQLITE_WAL_AUTOCHECKPOINT` | SQLite pragmas |
| `STAGEFLOW_ALLOW_NETWORK_STORE` | Escape hatch to boot on NFS/CIFS (unsupported) |
| `STAGEFLOW_TRIGGER_TICK_INTERVAL_MS` | Schedule-trigger tick (default 30000, `0` disables) |
| `STAGEFLOW_GITHUB_POLL_INTERVAL_MS` | GitHub-trigger poll (default 60000, `0` disables) |
| `STAGEFLOW_A2A_CONFIG` | Path to `a2a.yaml`. See [A2A](a2a.md) |
| `STAGEFLOW_OPERATOR_CWD`, `STAGEFLOW_OPERATOR_AGENT_DIR` | Operator checkout and Pi agent dir (CI) |
| `STAGEFLOW_CURSOR_EXTENSION` | Path to the Cursor Pi extension |
| `STAGEFLOW_AGENT_AUTH_PATH` | Provider auth file stamped into stage workspaces (`PI_HOME_AUTH_PATH` is the deprecated name) |

## Agents

| Variable | Default | Purpose |
|----------|---------|---------|
| `STAGEFLOW_AGENT_SESSION_IDLE_MINUTES` | 30 | Minutes of inactivity before a session's Pi session and MCP processes are released; `0` keeps them. Empty parses as `0` |
| `STAGEFLOW_AGENT_STALL_SECONDS` | 180 | Silence from the model before a turn fails; `0` turns the watchdog off. Empty parses as `0` |
| `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS` | 30000 | Agent schedule tick; `0` disables. See [Schedule an agent](guides-agents-schedule.md) |
| `STAGEFLOW_AGENT_CHANNEL_LISTENERS` | on | `0` stops the Host holding AgentMail and iMessage streams |
| `STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS` | off | `1` lets agents use `cursor/*` models, whose own file and shell tools bypass grants and approvals |
| `STAGEFLOW_PUBLIC_CHAT_ORIGINS` | none | Comma list of extra browser origins allowed to call the public chat API. See [Web chat](guides-agents-web-chat.md) |
| `STAGEFLOW_MCP_ENV_ALLOW` | none | Comma list of Host env names agents and **Check** may use to fill `${NAME}` in MCP servers. Provider and cloud credential names and the control tokens are never allowed |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Collector base URL; spans go to `<endpoint>/v1/traces` when an agent sets `observability.otlp: true` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none | Full traces URL; wins over the base endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | none | `key=value,key=value` headers sent to the collector |
| `PI_MCP_ADAPTER_OAUTH_FILE_KEY` | generated | Key for the encrypted MCP OAuth store (`agent/mcp-oauth-encrypted`). Keep the key and store together; losing either signs servers out |
| `PI_CODING_AGENT_DIR` | `$STAGEFLOW_HOME/agent` | Pi agent directory (set per stage attempt by the runtime) |
| `PI_CURSOR_SETTING_SOURCES` | none | Cursor setting sources for the Cursor provider |

## Set by the Host, not by you

Stages receive `STAGEFLOW_CHECKOUT`, `STAGEFLOW_RUN_WORKSPACE`, `STAGEFLOW_REPOSITORY`, `STAGEFLOW_REF`, `STAGEFLOW_BASE_SHA`, `STAGEFLOW_RUN_BRANCH` and `STAGEFLOW_STAGE_ARTIFACTS_DIR`. Do not set these on the Host.

## Docker

The shipped `docker-compose.yml` passes a fixed set of variables. Add others under `environment:` in your own override. See [Docker](docker.md).
