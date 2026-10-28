import type { GuideKnowledgeTopic } from "../index.js";

export const connectionsTopic: GuideKnowledgeTopic = {
  id: "connections",
  title: "Connections and stage channels",
  summary:
    "Host-level messaging connections (AgentMail, Slack, Telegram, iMessage, WhatsApp), how a stage sends with a pinned recipient, the one-channel-per-stage limit, secrets, live checks, and why an unknown send is never resent.",
  body: `# Connections and stage channels

A **connection** is a host-level link to a messaging provider. A stage lists it under \`channels:\` with the recipient fixed, and gets one tool, \`send_message\`. An agent can also answer people on one connection (see the agents topic).

## Providers

| Provider | What \`to\` is | Notes |
|---|---|---|
| AgentMail | One email or a list of up to 20, optional \`cc\` (up to 20). No \`bcc\`. | Uses one existing inbox (\`config.inbox\`). Plain text only, up to 64 KiB, optional subject. Key needs inbox read and send. |
| Slack | One id: channel \`C…\`, private \`G…\`, DM \`D…\` or user \`U…\`. Names like \`#general\` are refused. | Bot token (\`chat:write\`). A private channel needs the bot invited. |
| Telegram | Numeric chat id or a public channel \`@username\`. | The person must start the bot first. Text up to 4096 characters. |
| iMessage (Photon) | E.164 phone or Apple ID email, one recipient. | Free/Pro Photon projects: the person must be a registered project user and must text their assigned line once first. |
| WhatsApp (Photon) | E.164 phone, one recipient. | Free text only within 24 hours of the person's last message; otherwise pin an approved \`template\`. Send-only for everyone. |

iMessage and WhatsApp need the optional \`@spectrum-ts/*\` packages; without them sends fail with \`CHANNEL_PROVIDER_UNSUPPORTED\`.

## Stage YAML

\`\`\`yaml
channels:
  - connection: ops-slack
    to: C0123ABCD
    operations: [send]
\`\`\`

- \`connection\` (id), \`to\` (pinned recipient), \`operations\` (\`[send]\` is the only value today) are required. Optional: \`alias\`, \`cc\` (providers that support it), \`template\` (WhatsApp only).
- **One channel per stage** (\`MAX_CHANNELS_PER_STAGE\` is 1). A second entry is rejected at validate, in the console, at \`start_run\`, at run start and at send, including one inherited from a pipeline-level default. To notify on two providers, use two stages. One AgentMail connection can still reach several people through its \`to\` and \`cc\` lists.
- \`channels\` is a body key: put it in the stage file or inline entry, not on a \`uses:\` wrapper.
- A pipeline-level \`channels:\` is inherited by every stage; \`channels: []\` on a stage drops it.
- The recipient is chosen by the author. The agent can never pick a different one.
- Pi backend only. On the Claude backend a stage with \`channels:\` fails at start.
- Tell the agent in \`system_prompt\` what to send. It calls \`send_message\` with an \`operationKey\`.

## Secrets

- A secret is never a value in YAML. In \`connections.yaml\` it is \`env:NAME\` (read from the Host environment or \`NAME_FILE\`) or \`store:...\` (written by the console or tools into \`channel-secrets.json\`, mode 0600).
- \`create_connection\` and \`update_connection\` store secret values; no tool, API or screen ever returns them. Secrets never reach run state, logs, envelopes, artifacts or the stage worker.
- Do not repeat a secret back to the user.

## Where connections live

Host-level: \`$STAGEFLOW_HOME/connections.yaml\` (default \`~/.stageflow/connections.yaml\`), shared by every project on the Host. A \`connections.yaml\` next to a project's \`stageflow.yaml\` wins for that project. \`STAGEFLOW_CONNECTIONS_FILE\` overrides both. Console and tool edits apply without a restart; a hand edit needs a Host restart. Limits: 256 KiB, 100 connections, 20 shared credentials.

## Checks

1. \`validate\`: the connection exists and is enabled, the provider supports the operation, the target is valid. No network, no secret read.
2. Run start (also \`preflight\` and \`sf doctor\`): a live check of each connection. Failure blocks the run with \`channel_check_failed\`. It never sends a message.
3. The Host re-checks enabled connections every 5 minutes; \`test_connection\` checks values without saving.

## Sending and retries

- The Host sends with the pinned target. A repeated \`operationKey\` with the same content returns the first result without sending again; the same key with different content is \`CHANNEL_OPERATION_CONFLICT\`.
- A send that may have reached the provider is \`CHANNEL_SEND_OUTCOME_UNKNOWN\` and is **never resent**, even after a restart. Only definite failures (refused connection, DNS/TLS error, 4xx) may be retried, under a new key.
- Accepted means the provider took the message, not that anyone read it.

## Tools

\`list_connections\` (secret fields show only \`env\` or \`store\`), \`create_connection\`, \`update_connection\` (enable, rename, config, replace secrets), \`test_connection\`, \`validate_connection_target\` (checks a recipient against provider rules, no network), \`remove_connection\` (removes the entry and its stored secrets; destructive).

Email accounts (\`email.yaml\`, IMAP/SMTP, used by email triggers and the stage \`email\` permissions) are separate from connections. An IMAP account cannot be an agent channel; AgentMail can.
`,
};
