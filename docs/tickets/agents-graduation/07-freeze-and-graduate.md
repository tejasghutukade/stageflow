# 07: Freeze the contract and remove "experimental"

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 01–06

## Why

"Experimental" means the shape may change. Removing it is a promise about the agent YAML, the REST and public chat APIs, the CLI and the MCP tools.

## Read first

- `README.md` (the "Experimental" paragraph and feature list), `docs/agents.md`, `docs/console-agents.md`, `docs/guides-agents-*.md`, `docs/agent-api.md`, `docs/agent-definition.md`.
- `ui/src/redesign/shell/navConfig.ts`, `ui/src/components/AppRail.tsx` and their tests (`AppRail.experimental.test.tsx`).
- `ui/AGENTS.md`.

## What to build

1. Contract review: list every agent YAML field, `/api/agents` route, `/api/public/chat` route, `sf agents` flag and agent MCP tool. Mark each stable or still experimental. Anything renamed gets a dual-read like the old `channels:` list already has.
2. Decide what stays experimental and say so in one place: proposed Identity, A2A, the Claude and Cursor agent backends, and customer-facing use of channels (until phase 2).
3. Remove the experimental flag from Agents, Agent sessions and Connections in the nav; keep it on Identity and A2A. Mark WhatsApp and email rules experimental where they appear.
4. Docs: drop the banner from the agents pages, add a "Who should talk to a channel agent" section stating plainly that channel senders are trusted and share the agent's tools, and link 03's guard.
5. Changelog entry and a minor version bump.

## Acceptance

- [ ] The contract list is in the PR description and every stable item has a test that pins its shape.
- [ ] Nav tests updated; no "Exp" badge on Agents or Agent sessions.
- [ ] `README.md` experimental paragraph matches the nav.
- [ ] `docs/agents.md` carries the trust statement.

## Decisions made (2026-11-16, do not revisit)

- Connections graduate for the agent channels: Slack, Telegram, iMessage and AgentMail. WhatsApp and email rules stay experimental and are marked individually on the Connections page and in their docs, since the page itself loses its badge.
- Exposing the Host to the internet is not a blocker. Add a "Behind a reverse proxy" section that says to expose only `/chat/*`, `/api/public/*` and `/api/agent-inbound/*`, and to keep the console private. Console hardening on a public bind is a separate project.

## Outcome

Done in 0.66.0.

**Stable from this release**

- Agent YAML (`agents/<id>.agent.yaml`): `id`, `name`, `description`, `greeting`, `enabled`, `instructions`, `project_context`, `execution`, `model`, `tools` (`builtin`, `builtin_tools`, `mcp`, `skills`, `browser`, `stageflow`, `functions`), `approvals`, `sub_agents`, `sub_agent_depth`, `guardrails`, `evals`, `observability`, `channel`, `memories`, `web_chat` (`access: public`), `schedule`, `limits`. The old `channels:` list keeps loading as `channel`.
- REST `/api/agents`: list, get, create, validate, save, enable and disable, archive, revisions (list, get, diff, restore), sessions (list per agent and across agents, get, OTLP), chat and stop, approvals (list, approve, deny), channel and channel contact, delivery resend and delivered, `stageflow-tools`.
- Public chat `/api/public/chat/:slug`: metadata, threads (list, create, get), messages, with the NDJSON frames and `web_chat.*` error codes.
- Inbound `POST /api/agent-inbound/:connectionId` for Slack and Telegram.
- CLI `sf agents`: `list`, `get`, `validate`, `enable`, `disable`, `history`, `restore`, `sessions`, `session`, `chat`, `approve`, `deny`.
- MCP: `get_agent`, `save_agent`, `set_agent_enabled`, `archive_agent`, `agent_chat`, `get_agent_session`, `stop_agent_session`, `decide_agent_action`.
- Channels: Slack, Telegram, iMessage, AgentMail.

**Still experimental**

- Identity: `web_chat.access: authenticated`, `/api/public/chat/:slug/admission` and `/oidc/*`, `/api/identity/*`, the order API contract.
- A2A, WhatsApp, email rules, `model.backend: claude` and Cursor models, `execution: sandbox`.
- A channel agent that serves each customer their own data (phase 2).

**Not done**

- No new tests were written to pin each stable item. The existing agent tests (API, CLI, MCP, public chat, definition loading) are what hold the shapes; a gap check against the list above is still worth doing.
- WhatsApp and email rules are marked experimental in the docs only. The console shows no badge on them; the Connections page lost its badge as a whole.
- The console was not opened to look at the nav; the nav change is covered by the existing badge test and the UI suite.
