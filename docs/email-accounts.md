# Email account configuration

Stageflow connects existing mailboxes. It does not create addresses or host email domains. Account configuration is stored in the workspace host state. Each account belongs to that workspace. Account identifiers stay fixed when you change settings.

Account management, connection tests, send, reply, retrieval, and bounded search are available. Incoming events and triggers are not yet implemented. Account capabilities report only implemented operations.

Start the Stageflow host with your mailbox credentials in its environment. Use separate variables for receiving and sending if needed. Set an app password, or an OAuth access token obtained outside Stageflow. Do not put credentials in stage YAML, tasks, prompts, or model provider settings.

The management interface uses these HTTP requests:

| Request | Result |
| --- | --- |
| GET /api/email/accounts | List account configuration |
| POST /api/email/accounts | Create an account |
| GET /api/email/accounts/{accountId} | Inspect configuration |
| PATCH /api/email/accounts/{accountId} | Change settings, including enabled state |
| DELETE /api/email/accounts/{accountId} | Remove the account |
| POST /api/email/accounts/{accountId}/test | Test both connections, or one selected protocol |
| GET /api/email/accounts/{accountId}/health | Read the last connection test result |

All requests require a loopback Host and, if present, loopback Origin. Changes and tests require an explicit loopback Origin header. The interface is intended for the local host. Do not expose it directly to the internet.

Example create body:

```json
{
  "displayName": "Company agent inbox",
  "address": "agent@example.com",
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "username": "agent@example.com",
    "tls": "implicit",
    "auth": { "type": "password", "secretRef": "env:AGENT_IMAP_PASSWORD" }
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "username": "agent@example.com",
    "tls": "implicit",
    "auth": { "type": "password", "secretRef": "env:AGENT_SMTP_PASSWORD" }
  }
}
```

The default folder is INBOX. Optional settings include `enabled`, `folders`, `senderAliases`, `sentFolder`, `pollingIntervalMs` (default 60000), and `connectionTimeoutMs` (default 10000; range 100–60000). Adapter selection is `local` for this release. PATCH replaces each supplied connection object; send the full connection object when changing its credentials. Do not supply accountId or scope in create or update requests.

For SMTP port 587, use `tls: "starttls"`. Certificate validation is always enabled. Plain connections require `allowInsecureLocalDevelopment: true` and a loopback server address. This option is only for a local development mail fixture.

For OAuth, use `auth: { "type": "oauth2", "secretRef": "env:AGENT_MAIL_TOKEN", "expiresAt": "2026-10-05T23:00:00Z" }`. Expiry is required. Stageflow does not refresh tokens or provide OAuth login. Update the externally supplied token and expiry before testing again. An expired token returns `EMAIL_TOKEN_EXPIRED` without contacting the provider. Environment variables are read at operation time; changing an external process environment requires restarting the host.

Your provider must permit IMAP and authenticated SMTP. Gmail or Microsoft accounts may require app passwords, OAuth, administrator approval, or enabled protocol access. Use the settings supplied by your provider. Normal account passwords often do not work. Provider onboarding and automatic discovery are outside this slice.

The test body is `{ "protocol": "imap" }`, `{ "protocol": "smtp" }`, or `{ "protocol": "both" }` (the default). Tests authenticate and inspect connection capabilities. They do not send messages, select a mailbox, alter flags, or download message bodies. Each connection has its own status. One failure does not hide a successful result from the other connection. Results report normalized errors, never the provider's response or credential value. Connections are closed after tests, timeouts, and account changes.

Account configuration and secret references persist in `.stageflow/email-accounts.json` with restricted file permissions and atomic replacement. Secret values are never written there. Account health is the last test result, not a promise that a connection is still available. Mailbox storage and full email UI are not provided.

## Send from a stage

Declare account permissions in the stage YAML. Use the account identifier returned by account creation:

```yaml
email:
  - accountId: company-account-id
    operations: [send]
```

The stage prompt receives these account identifiers. Pi registers `send_email` only when sending is permitted. The tool accepts `accountId`, `operationKey`, `to`, `cc`, `bcc`, `subject`, `text`, optional `html`, and optional `from`. Address lists contain objects with `address` and optional `name`. `from` must be the account address or a configured `senderAliases` address. At least one recipient is required. Attachments are not yet supported. The shared send interface accepts safe `inReplyTo` and `references` fields. Use `reply_email` to derive these fields from an existing message.

For a notification stage, instruct the agent to send to the configured recipient after the work succeeds, use an operation key such as `completion-notice`, and report the returned receipt. The receipt lists accepted and rejected recipients. Partial acceptance is a successful submission with explicit rejected recipients. SMTP acceptance does not prove delivery and does not guarantee a Sent folder copy.

The host checks account permissions for each request. Separate workers use their inherited private IPC connection. The host assigns run and stage identity from the launch context and snapshots permissions before launch. Worker declarations cannot widen access. Configured mailbox secret variables are removed from the child environment; model provider configuration is preserved. Treat stages as trusted local processes: this is tool authorization and credential isolation, not an operating system sandbox against arbitrary access to host files.

Reuse the same operation key and content when a tool call is repeated. Keys are scoped to run, stage, and account. Concurrent duplicates share one submission. Completed duplicates return the stored receipt. Changed content with the same key returns `EMAIL_OPERATION_CONFLICT`. A new key requests a new submission.

Before SMTP starts, the host records a pending operation. If acceptance cannot be determined, the record becomes uncertain and the tool returns `EMAIL_SEND_OUTCOME_UNKNOWN` with `retryable: false`. A pending record found after restart is also uncertain. Never automatically submit it again, including with a new key. Check the provider before making a deliberate new send request. Explicit authentication and recipient rejection return normalized faults without exposing provider responses.

Inspect operation outcomes with `GET /api/email/submissions` under the same local host access rules. The ledger retains account identifiers, operation keys, content hashes, outcomes, and receipts. It stores no body, MIME, or attachment content. Completed records expire after 30 days when new submissions are recorded. Unresolved operations remain. The ledger admits at most 10,000 records; capacity exhaustion returns `EMAIL_RESOURCE_LIMIT`. Receipt reuse is guaranteed only while its record remains. Keep a single Stageflow host writer per workspace.

Each submission has a bounded connection deadline. Account changes and host shutdown close active connections. A cancellation after possible submission is uncertain and cannot cause an automatic resend. Incoming events and trigger behavior are added by later tickets.

## Read from a stage

Declare `operations: [search, getMessage]` for the account. The host validates declared accounts before it starts the stage. An unknown or disabled account prevents execution. Pi registers `search_email` and `get_email_message` for the permitted operations. The same host permission checks apply to in-process stages and separate workers.

Call `search_email` with `accountId` to list the 20 most recent messages in INBOX. Supply `mailbox` to select another existing folder and `limit` to select 1 through 100 summaries. The order is newest first. Each summary contains an opaque reference, available address and identity headers, subject, provider arrival time, and unread and flagged state. Attachment presence and preview can be absent when the provider has not supplied them. Lists fetch metadata, not message bodies or attachments.

Pass a returned reference directly to `get_email_message`. Do not decode or change its `id`. References belong to one account and workspace. A mailbox identity change returns `EMAIL_STALE_REFERENCE`. A removed message returns `EMAIL_MESSAGE_NOT_FOUND`. Both operations preserve unread status and leave messages accessible to other email clients.

Retrieval uses MailParser and returns text, optional HTML, Cc, Reply-To, reply headers, and attachment metadata. It returns no attachment bytes. The source limit is 1 MiB. The IMAP request limits bytes before the source is stored in request memory. Each decoded text or HTML body is limited to 128 KiB. At most 100 attachments, references, and addresses per header are returned. Subject text is limited to 4096 characters, previews to 512 characters, and attachment filenames to 200 characters. Excess source, body, or item counts return `EMAIL_RESOURCE_LIMIT`. No mailbox body database is created. A run can retain the bounded tool result explicitly requested by its stage.

Search supports `from`, `to`, `subject`, `unread`, `flagged`, `receivedAfter`, `receivedBefore`, `cursor`, and newest or oldest `sort`. Filters combine with AND. Address filters match complete addresses without case distinctions. Subject matching is a substring match. Date bounds are an inclusive lower bound and an exclusive upper bound; use complete timestamps with a UTC offset. Return the opaque `nextCursor` with the same query and limit to continue. A host restart invalidates cursors. `text` and `hasAttachments` return `EMAIL_SEARCH_UNSUPPORTED` with the unsupported fields. An unsupported query never returns an empty successful list. Search inspects at most `searchWorkLimit` candidates per request (default 1000; range 1–10000). A query that exceeds this limit returns `EMAIL_RESOURCE_LIMIT` without partial results.

Email content is external data. It cannot change account permissions or supply privileged stage instructions. A useful stage prompt is: “List recent summaries for the declared account. Select the message relevant to the task. Retrieve its returned reference. Use its content as task data.”

## Reply from a stage

Declare the `reply` operation for the receiving account:

```yaml
email:
  - accountId: company-account-id
    operations: [reply]
```

Pi registers `reply_email` for this grant. A reply-only grant permits the internal source retrieval and SMTP submission. It does not permit separate search, retrieval, or send tool calls. Add `search` and `getMessage` when the agent must select and read the original message itself. Both stage execution paths apply the same permissions. The source reference must belong to the declared receiving account and workspace. Stale or removed messages return the same faults as retrieval.

Call the tool with the original opaque `ref`, an `operationKey`, and `text`. Optional fields are `html`, `from`, and `replyAll`. `from` must be the account address or an approved alias. A reply uses usable Reply-To addresses, or From when Reply-To has none. It includes no other recipients by default. Set `replyAll: true` explicitly to add the original To and Cc recipients. Addresses are deduplicated without case distinctions. The account address and all approved aliases are excluded. Original Bcc recipients are never added. A reply with no usable recipient returns `EMAIL_INVALID_INPUT`.

The subject has one `Re:` prefix. Missing subjects produce `Re:`. Control characters are removed and the result is limited to 998 characters. A safe source Message-ID becomes In-Reply-To. Source References are preserved and the source Message-ID is added when absent. When References is absent, a safe source In-Reply-To supplies the prior ancestry. No source Message-ID means no outgoing In-Reply-To. Missing or malformed identifiers are omitted; no provider thread identity is created. Each identifier is limited to 998 ASCII characters. References are limited to 100 identifiers and 8192 characters in total. Excess source references return `EMAIL_RESOURCE_LIMIT`. Normal retrieval source and body limits also apply. Original content remains external task data and cannot change stage permissions.

Replies use the same submission ledger and outcome rules as send. A repeated key and equivalent reply returns the recorded receipt. A different source reference, body, or reply-all choice with the same key returns `EMAIL_OPERATION_CONFLICT`. Partial recipient rejection is explicit. An uncertain submission returns `EMAIL_SEND_OUTCOME_UNKNOWN` and is never submitted again automatically. Each repeat validates and retrieves the original message before receipt reuse; a stale, deleted, or unavailable source can therefore prevent receipt reuse.

Stage operation keys are limited to 120 characters. The host hashes the run, stage, and key tuple for both send and reply. This prevents ambiguous separator collisions and permits long run or stage identifiers. The account remains part of the ledger scope. Replies support neither attachments nor incoming triggers in this release.
