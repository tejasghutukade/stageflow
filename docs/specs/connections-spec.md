---
status: proposed
---

# Spec: Connections (communication channels and tools)

> **Scope update 2026-10-14:** phase 1 shipped as **send-only** stage channels. Built: the five providers (AgentMail, Slack, Telegram, iMessage and WhatsApp via Photon), `connections.yaml` with `env:` and console-written `store:` secret references, a host-level file, run-start live checks, the Connections page with connect/test/replace/disconnect, and a stage-inspector picker. A stage uses one channel. Not built: receiving, agent binding and conversations, the Slack app-manifest flow, AgentMail inbox creation, WhatsApp own-Meta-app mode, local iMessage, tool connectors beyond a read-only `.mcp.json` list, and the per-provider detail layouts beyond a common one. The shipped behavior is documented in [docs/channels.md](../channels.md); where this spec differs, that page wins.

**Status: partly implemented (see the scope update above). The rest of this spec is still a proposal.** Designs exist in Wonder (see [connections-design-handoff.md](connections-design-handoff.md)). Verified third-party facts live in [connections-provider-reference.md](connections-provider-reference.md). Read both before implementing.

Anything marked **Decision needed** is an open product or architecture question. Do not silently pick an answer. Ask the owner or record the choice in this file.

## Problem Statement

Stageflow runs agents, but people can only reach them through the operator console, CLI, or MCP. Operators want to talk to an agent where they already work: Slack, email, iMessage, WhatsApp, Telegram. The agent's channel becomes its primary way to be reached, with no UI to build.

Separately, agents need to reach out to other services (GitHub, Notion, PagerDuty). Those are tools the agent calls. They are not a way to talk to the agent.

Today the console has a read-only **Connections** page that lists email accounts only. Accounts are configured in `email.yaml` and need a host restart to change. There is no way to connect any other channel and no way to set one up from the UI.

## Current state (verified in the repo)

- Route `connections` exists: `ui/src/routes.ts` (`path === "connections"`), rendered in `ui/src/App.tsx`.
- `ui/src/pages/ConnectionsPage.tsx` is read-only. It calls `fetchConnections()` in `ui/src/api/client.ts`, which maps `GET /api/email/accounts` to a flat `ConnectionListing` (`id`, `channel: "Email"`, `displayName`, `address`, `enabled`, `folders`).
- Email accounts are IMAP/SMTP only (`src/email/`, `docs/email-accounts.md`). Stageflow "connects existing mailboxes. It does not create addresses or host email domains." Config comes from `email.yaml` or `POST /api/email/accounts`. File-managed IDs cannot be edited over HTTP.
- Stages reference an account ID through their `email` permissions. Credentials never go in stage YAML, tasks, or prompts.
- Email triggers are push-based over IMAP IDLE (`src/runtime/emailSource.ts`).
- The sidebar nav has an **Agents** item marked "Soon". **There is no agent definition model in the repo today**, although the Wonder file contains Agents screens (directory, create, edit, details). See the dependency under [Agent assignment](#agent-assignment).
- Hard rules to keep (from `AGENTS.md` and `docs/browser-internals.md`): YAML never carries a path or secret. The owner scope is fixed to `local` today. New code must take a scope as input, never a literal, and must be marked `TODO(multi-tenant)` where hosted behaviour is deferred.

## Solution

One **Connections** page with two sections:

1. **Communication channels.** A connection lets people message an agent. Providers in scope: AgentMail, Slack, iMessage, WhatsApp Business, Telegram.
2. **Tools.** A connection gives an agent capabilities during a run (GitHub, Notion, PagerDuty, any MCP server).

Both sections share one page, one **Add connection** picker, and one detail pattern. Communication connections are set up in a provider-specific dialog, tested, and then assigned to agents. A connection is made once and assigned many times. The Connections page owns the credentials. The agent screens only choose among existing connections.

### Decisions already made by the owner

- One page with two sections (not two pages, not tabs).
- Connection first, then assign agents. A connection can serve several agents and an agent can have several connections.
- Photon appears as separate cards per channel (iMessage, WhatsApp Business, Telegram), each tagged "Photon", sharing one saved Photon project credential. Slack uses its own native Slack app, not Photon's Slack.
- WhatsApp supports both Photon and bring-your-own Meta app.
- Designs to deliver: overview, add-connection flow per type, connector detail.

## Data model (proposed)

Generalise the current email-only listing into a provider-neutral model. Names are proposals.

```ts
type ConnectionKind = "communication" | "tool";
type ConnectionProvider =
  | "agentmail" | "slack" | "imessage-cloud" | "imessage-local"
  | "whatsapp-photon" | "whatsapp-meta" | "telegram" | "email-imap" | "mcp";

type Connection = {
  id: string;                    // stable, [A-Za-z0-9._-], like email accountId
  scope: string;                 // owner scope; "local" today, taken as input
  kind: ConnectionKind;
  provider: ConnectionProvider;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;       // non-secret, provider-specific
  credentialRef?: string;                // id of a ProviderCredential
  secretRefs: Record<string, string>;    // never plaintext; see Secrets
  health: ConnectionHealth;
  createdAt: string; updatedAt: string;
};

type ConnectionHealth = {
  state: "ok" | "failed" | "unknown";
  checkedAt?: string;
  error?: { code: string; retryable: boolean };
};

// One Photon project backs iMessage cloud, WhatsApp (Photon) and Telegram.
type ProviderCredential = {
  id: string; scope: string; provider: "photon";
  secretRefs: { projectId: string; projectSecret: string };
};

type ChannelBinding = {            // which agent answers where
  connectionId: string;
  agentId: string;
  rule: Record<string, unknown>;   // provider-specific, see Agent assignment
};
```

**Decision needed:** whether the existing `EmailAccounts` store is migrated into this model or the email-IMAP provider keeps its own store and is only surfaced through a shared listing endpoint. Do not break `email.yaml`, `/api/email/accounts`, or stage `email` permissions either way.

## Secrets

The designs promise "Stored on this host. Never written to YAML. Never shown again."

The existing email pattern (`docs/email-accounts.md`) resolves secrets from the host environment or from `email.yaml`. Inline YAML passwords are swapped for opaque references and held in host memory only, then reloaded from YAML on restart. OAuth tokens must come from the environment. **That pattern does not persist a secret a user types into the browser.** The UI flows in these designs need a persistent host secret store.

**Decision needed:** how host-side secrets entered in the UI are persisted. Candidates: OS keychain, or an encrypted file under `$STAGEFLOW_HOME` (default `~/.stageflow/`). Constraints:

- Never return a secret over any HTTP or MCP response. Return only "set" or "not set" and a masked tail (the detail page shows `am_••••••••••••a3f9`).
- Allow `env:NAME` references too, matching the existing `secretRef` convention.
- Key every secret by owner scope. Pass scope in, never hardcode `local`.
- Worker processes must never receive connection secrets. Only the Host talks to providers.

## Provider adapter contract (proposed)

Providers differ a lot (WebSocket, gRPC stream, webhook, Socket Mode). Hide that behind one Host-side interface so the scheduler and trigger code see one event shape.

```ts
interface ChannelProvider {
  id: ConnectionProvider;
  validate(input: unknown): Promise<ValidationResult>;       // used by the dialog's live check marks
  test(connection: Connection): Promise<ConnectionHealth>;   // "Test connection" button
  start(connection: Connection, emit: (e: InboundMessage) => Promise<void>): Promise<void>;
  stop(connection: Connection): Promise<void>;
  send(connection: Connection, to: ConversationRef, msg: OutboundMessage): Promise<SendResult>;
}
type InboundMessage = {
  type: "channel.message.received"; version: 1; eventId: string;
  connectionId: string; provider: ConnectionProvider;
  conversation: ConversationRef;       // provider-neutral thread/space/chat id
  sender: { id: string; display?: string };
  content: { text?: string; attachments?: Attachment[] };
  receivedAt: string;
};
```

Mirror `src/email/port.ts` (`EmailMailbox`, `EmailEventSource`, typed error codes, `operationKey` idempotency on send). Mirror the email adapter's lifecycle rules: watchers run only inside the long-running HTTP/UI host, reconnect with bounded backoff, and resume from a persisted watermark where the provider supports replay. Tests use injected fake providers, never real network calls.

**Decision needed:** whether inbound channel messages reuse the existing trigger system (`event.source: channel.*`, same pattern as `email.*`) or a new conversation-binding path. The agent-answers-in-a-thread behaviour is conversational, not one trigger per message. Do not assume the trigger model fits without checking `docs/yaml-catalog.md` (Triggers) and `src/runtime/emailSource.ts`.

## Agent assignment

The designs let the operator choose which agent answers on each connection. This is the least-grounded part of the design.

- **Dependency:** agents do not exist in the repo as a definable entity yet (nav says "Soon"). The assignment UI cannot ship until an agent model exists. A connection must be fully usable without any assignment ("Optional, change anytime" in the dialogs).
- **Slack routing (Decision needed).** The Slack dialog shows per-agent rules ("DMs + #ops-alerts", "#releases"). Slack itself only delivers DMs and @mentions to the app. Which agent replies is Stageflow logic invented for the design. Options: keep per-agent rules; or one agent per Slack connection. Do not implement routing until the owner chooses.
- iMessage, WhatsApp (Photon), Telegram, AgentMail: the designs show a single answering agent per connection, except WhatsApp-Photon, which shows one agent per phone number.
- AgentMail detail shows "Replies to every new thread" and "CC'd only, never sends" for a sub-agent. Those rules are also design proposals.

## Provider setup flows (must match provider docs)

Summary only. Exact facts, field names and URLs are in [connections-provider-reference.md](connections-provider-reference.md).

| Provider | Credentials the user supplies | Inbound transport | Stageflow needs a public URL? |
| --- | --- | --- | --- |
| AgentMail | API key (optionally inbox-scoped) | WebSocket (default in design) or webhook | No for WebSocket. Yes for webhook. |
| Slack | App-level token `xapp-` and bot token `xoxb-` from the user's own Slack app | Socket Mode | No |
| iMessage, Photon cloud | Photon project ID and secret | Managed lines over gRPC | No |
| iMessage, This Mac | none | Reads local Messages database | No (host must be that Mac) |
| WhatsApp via Photon | Photon project ID and secret, plus WhatsApp enabled in the Photon dashboard | Photon relays the webhook | No |
| WhatsApp own Meta app | Phone number ID, access token, app secret, plus Meta webhook configured by the user | Meta webhook to Photon's shared endpoint | No (Photon's endpoint receives it) |
| Telegram | Bot token (and optional webhook secret) plus Photon project | Photon "Fusor" webhooks | No |

Rules the UI must respect, all from provider docs:

- iMessage line type (shared vs dedicated) is determined by the Photon plan. It is not a user choice. Show it read-only.
- Photon cloud discovers every line on a project automatically. Show lines as detected. Never ask the user to pick or type one.
- Photon tokens auto-renew in cloud mode. Do not design or surface a "token expiring" warning for it.
- Photon platform toggles (WhatsApp, Telegram) are enabled in the Photon dashboard, not in Stageflow. The WhatsApp dialog must say so.
- WhatsApp Business is 1:1 only. There are no group chats.
- iMessage group chats and group events need a Photon Business dedicated line. "This Mac" mode has no reactions, edits, unsend, read receipts, typing or group creation.
- Slack Socket Mode apps cannot be listed in the public Slack Marketplace. That is fine for an operator's own workspace. Note it in docs.
- AgentMail IMAP is "coming soon" on their side. The AgentMail provider must use their API and WebSocket, not Stageflow's existing IMAP/SMTP email provider.

## Screens and states

See [connections-design-handoff.md](connections-design-handoff.md) for artboard IDs and per-screen detail. Behaviour the implementation must cover that the static designs only imply:

- **Overview.** Sections in this order: Communication, Tools. Status vocabulary: Connected, Needs setup, Disabled. Only show a warning state when a real, documented condition exists (see rules above). Footer counts must be real.
- **Add connection picker.** Search filter. Opens the provider dialog. Tools entries open the MCP flow (out of scope for the first phase, see Phasing).
- **Provider dialogs.** Each secret field validates live (the designs show check marks). "Test connection" runs `ChannelProvider.test`. The primary button is disabled until validation passes. Dialog errors use the provider's typed error code, never a raw provider message.
- **Detail page.** Currently designed for AgentMail only. Other providers need the same shell with provider-specific side panel rows. Sections: agents on this connection, recent conversations (each linked to a run), side panel (identity, delivery, credential, disconnect).
- **Disconnect.** Confirm, stop the watcher, keep history, never delete the remote resource (design copy says the AgentMail inbox itself is not deleted).
- **Empty state, loading, error and disabled states are not designed.** Reuse the patterns on the existing Agents and Triggers screens. Ask before inventing new ones.

## Phasing (proposed)

1. **Foundation.** Connection model, scope handling, host secret store, provider registry and adapter interface, health checks, list and detail API, Connections page reading both kinds. Email IMAP shown through the new listing without behaviour change.
2. **AgentMail.** Provider adapter (API plus WebSocket, optional webhook), dialog, detail page, test connection, inbound events into the conversation or trigger path.
3. **Slack.** Manifest generation, Socket Mode, token validation (workspace detection), dialog. Routing only after the owner decides.
4. **Photon.** Shared Photon credential, then iMessage cloud, WhatsApp via Photon, Telegram. Then iMessage local and WhatsApp own-Meta as modes of those providers.
5. **Tools section.** Map to project MCP servers (`docs/yaml-catalog.md`, Stage MCP and `.mcp.json`). The mapping from "tool connection" to those files is **not verified**. Read that doc and `src/mcp` before designing the backend.
6. **Agent assignment.** Blocked on the agent model.

## Out of scope

- Authoring agents, agent screens, or agent bindings beyond the assignment hook.
- Slack routing rules (pending decision), Discord, Instagram, voice calls (Photon supports them; not designed).
- Hosted multi-tenant behaviour. Keep `scope` as an input everywhere and leave `TODO(multi-tenant)` markers.
- Any change to `email.yaml`, `/api/email/*`, or stage `email` permissions.
- Persisting provider secrets in YAML, catalog files, run artifacts, logs or envelopes.

## Testing requirements

- Provider adapters get injected fake clients. No real network or real provider accounts in the default suite.
- Contract tests for the adapter interface that every provider runs.
- A secret-leak test: no connection secret appears in any API response, log line, envelope, artifact or error message.
- UI tests with `ui:test` for the overview and each dialog's validation states. Follow patterns in `ui/src/pages/*.test.ts`.
- Run `npm test`, `npm run ui:test`, `npm run typecheck` before finishing, as in `AGENTS.md`.

## UI implementation notes

- The console uses Astryx plus chrome primitives in `ui/src/console.css`. Read `ui/AGENTS.md` first. The Wonder designs use `--sf-*` tokens and Tailwind-style classes. Map them to the console's `--color-*`, `--spacing-*`, `--radius-*` tokens. Do not copy Wonder class names into the repo.
- Reuse the existing page frame, table, and drawer primitives. The overview and detail screens were built by copying the Agents Directory artboard, so they follow the same shell.

## Open decisions (collected)

1. Migrate `EmailAccounts` into the new model, or surface it through a shared listing only?
2. Persistent secret store for UI-entered secrets (keychain vs encrypted file under `$STAGEFLOW_HOME`).
3. Inbound messages: extend the trigger system or add a conversation-binding path?
4. Slack routing: per-agent rules or one agent per connection?
5. Does Slack via Photon ever replace native Slack? The Photon SDK provider docs do not list Slack yet; their cloud API has Slack endpoints.
6. Agents model and where assignment is stored.
7. How the Tools section maps to project MCP configuration.
8. Whether "This Mac" iMessage and a remote Stageflow host can coexist, since the mode only works when the host is that Mac.
