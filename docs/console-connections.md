---
layout: default
title: Console - Connections
---

# Connections

`#/connections` lists everything Stageflow talks to, in four sections:

| Section | Contents |
|---------|----------|
| **Communication channels** | Connections from `connections.yaml`: AgentMail, Slack, Telegram, iMessage (Photon), WhatsApp (Photon). Used by stages (`channels:`) and by [agents](agents.md) (send and receive) |
| **Email accounts** | IMAP accounts for email triggers; see [Email accounts](email-accounts.md). An IMAP account cannot be an agent channel (AgentMail can) |
| **Tools** | MCP tool servers from the project `.mcp.json` and the ones saved from the console. Add and edit them in [Settings → Project MCP](console-settings.md#project-mcp); see [MCP servers](mcp-servers.md) |
| **Browser logins** | Saved browser logins (profiles) used by stages with `browser:`: sites, where each login was made, last login and check, and whether it is pinned to your own Chrome. Actions: Check now, Log in again, Switch back, Delete. See [Browser sessions](browser.md#saved-logins) |

On a first run the page shows the providers you can connect. **Add connection** opens the connect dialog for a provider: fill the fields (secrets are write-only), **Test connection** checks the values without saving, then save.

## One connection (`#/connections/<id>`)

- **Status**: the last health result and a fix hint for the error code; the host re-checks each enabled connection every 5 minutes. **Test connection** runs a live check and never sends a message.
- **Use in a stage**: the `channels:` snippet to paste into a stage.
- **Enable / Disable** (header): a disabled connection is skipped by stages and agents.
- **Credential**: replace a key (the old value is never shown).
- **Disconnect**: removes the entry, its stored secrets and a shared credential nothing else uses.

An agent bound to a connection (its `channel.connection_id`) listens on it: the connection must be enabled and healthy for the agent to answer. See [Communication channels](channels.md#connections-page-and-api) for the endpoints and error codes, and the per-channel guides for agents: [email](guides-agents-email.md), [iMessage](guides-agents-imessage.md), [Slack](guides-agents-slack.md), [Telegram](guides-agents-telegram.md).
