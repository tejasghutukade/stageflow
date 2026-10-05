# Email account configuration

Stageflow connects existing mailboxes. It does not create addresses or host email domains. Account configuration is stored in the workspace host state. Each account belongs to that workspace. Account identifiers stay fixed when you change settings.

This first slice provides account management and connection tests. Send, reply, retrieval, search, and incoming events are declared but return `EMAIL_UNSUPPORTED` until their tickets are implemented. Account capabilities report only implemented operations.

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
