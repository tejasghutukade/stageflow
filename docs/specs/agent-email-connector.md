---
status: ready-for-agent
---

# Spec: Agent email connector for Stageflow

## Problem Statement

Stageflow operators need to connect existing company email accounts to stages and agents. An agent must be able to send a notification, reply to a message, retrieve a message, and search a mailbox. An incoming message must also be able to start a pipeline or agent action when it matches a configured trigger.

The email provider must remain the source of truth. Operators must still be able to use Gmail, Outlook, or another email application with the same account. Stageflow does not need to host email accounts, change domain routing, build an email application, or maintain a second mailbox database.

The first implementation must run with local Stageflow and use open source libraries without a required connector subscription. Its interface must allow a later replacement with a separate email process, such as an extended Mail MCP implementation. That replacement must not require changes to stage prompts, pipeline definitions, trigger rules, or agent tool inputs.

## Solution

Add an email module that connects one or more existing accounts through IMAP and SMTP. Use ImapFlow for mailbox access and incoming message detection, Nodemailer for outbound email, and MailParser for MIME parsing. Run the mailbox watcher in the long running Stageflow host. Use IMAP IDLE when available and polling when necessary.

Expose account testing, send, reply, message retrieval, and search through a provider independent EmailMailbox interface. Expose incoming messages through an EmailEventSource facet of the same module. Agents and triggers use Stageflow email types and account identifiers. The local adapter owns all protocol details.

Configure accounts at the Stageflow host level. A stage declares which accounts and operations it can use. A trigger selects an account, message filters, and a runnable target. The email module emits a normalized email.received event. Trigger handling uses the existing pipeline validation, run creation, capacity checks, and execution path.

Keep only account configuration, secret references, watcher progress, event and dispatch metadata, and operation receipts. Retrieve message content from the provider when required. Any optional sent or received activity view uses plain summaries and does not require a mailbox UI.

In a later phase, a RemoteEmailAdapter can implement the same interface with authenticated HTTP or MCP calls to an external email process. Incoming events can return through signed webhooks. Building that external process and its Mail MCP trigger support is deferred.

## User Stories

1. As an operator, I want to connect an existing company inbox, so that agents can use the account I already manage.
2. As an operator, I want to connect several accounts, so that different stages can use different email addresses.
3. As an operator, I want to enter IMAP and SMTP hosts, ports, and TLS settings, so that I can use a provider that Stageflow does not recognize.
4. As an operator, I want to configure separate IMAP and SMTP credentials when needed, so that I can use providers with different authentication settings.
5. As an operator, I want to use an app password or a supported OAuth token, so that I can meet my provider's authentication requirements.
6. As an operator, I want to test receiving and sending connections separately, so that I can identify configuration faults.
7. As an operator, I want connection testing to avoid sending a real message, so that account setup does not contact recipients.
8. As an operator, I want clear account health information, so that I can detect an expired token or disconnected watcher.
9. As an operator, I want to update account settings, so that I can rotate credentials or change servers.
10. As an operator, I want to disable or remove an account, so that Stageflow stops accessing it.
11. As an operator, I want account identifiers to stay stable, so that credential rotation does not break stage configuration.
12. As an operator, I want my usual email application to retain access to incoming messages, so that Stageflow can work beside it.
13. As an operator, I want mailbox reads to preserve unread status, so that agents do not change my personal triage state.
14. As a pipeline author, I want to select an email account for a stage, so that the agent uses the correct company address.
15. As a pipeline author, I want to declare which email operations a stage can use, so that its tools match its assigned work.
16. As a stage agent, I want to send an email with recipients, subject, and body, so that I can notify people outside Stageflow.
17. As a stage agent, I want to send an attachment from a run artifact, so that I can share the result of my work.
18. As a stage agent, I want a send receipt, so that I can report whether the provider accepted the message.
19. As a stage agent, I want to reply to a retrieved message, so that I can continue an existing conversation.
20. As a stage agent, I want reply headers to preserve conversation threading, so that recipients see a coherent email thread.
21. As a stage agent, I want to retrieve one message by its reference, so that I can read the content needed for a task.
22. As a stage agent, I want to search by sender, recipient, subject, and date, so that I can find a specific message.
23. As a stage agent, I want to search message text when supported, so that I can find an email without its exact subject.
24. As a stage agent, I want to list unread messages, so that I can find work that needs attention.
25. As a stage agent, I want to list recent messages without a filter, so that I can inspect mailbox activity.
26. As a stage agent, I want to search a configured mailbox folder, so that I can inspect an archive or sent folder.
27. As a stage agent, I want paginated search results, so that a large mailbox does not exceed my context or response limits.
28. As a stage agent, I want message summaries before full bodies, so that I can select relevant messages with less data.
29. As a stage agent, I want clear errors for unsupported filters, so that I do not treat incomplete results as complete results.
30. As an operator, I want an incoming email to start a pipeline, so that email can become an external entry point for automation.
31. As an operator, I want to filter a trigger by sender and subject, so that only relevant email starts work.
32. As an operator, I want a trigger to identify the account and folder it watches, so that unrelated inboxes do not start work.
33. As an operator, I want a matching message to supply context to the run, so that the agent knows why the run started.
34. As an operator, I want to target an existing runnable agent entry point when available, so that an email can start a focused action.
35. As an operator, I want a one stage pipeline to provide that focused action when no standalone agent entry point exists, so that email automation does not require a second execution system.
36. As an operator, I want to enable and disable trigger rules, so that I can control automation without removing the account.
37. As an operator, I want messages already in the inbox to stay inactive on first connection, so that setup does not start old work unexpectedly.
38. As an operator, I want an explicit replay option for selected historical messages, so that I can process earlier email when needed.
39. As an operator, I want reconnection to find messages received during an outage, so that a short connection fault does not lose work.
40. As an operator, I want duplicate message detection, so that reconnects and repeated events do not create duplicate runs.
41. As an operator, I want temporary run capacity faults to leave trigger work pending, so that messages are not silently discarded.
42. As an operator, I want one broken account to leave other accounts active, so that a credential fault has limited impact.
43. As an operator, I want connection retry delays, so that an outage does not cause continuous requests to the provider.
44. As an operator, I want secrets excluded from prompts and activity records, so that agent work does not expose account credentials.
45. As an operator, I want a simple record of send and trigger outcomes, so that I can diagnose email automation.
46. As an operator, I want Stageflow to avoid a second mailbox database, so that I do not have to manage duplicate email storage.
47. As a maintainer, I want one email interface for local and remote adapters, so that I can replace the implementation later.
48. As a maintainer, I want a test adapter that uses no network or real credentials, so that I can verify pipeline integration reliably.
49. As a maintainer, I want shared adapter contract tests, so that a replacement preserves user behavior.
50. As a maintainer, I want search methods defined even before every filter is implemented, so that later support does not require a new agent interface.

## Implementation Decisions

### Current codebase and domain terms

- Use the existing terms operator, catalog, pipeline, stage, task, run, envelope, artifact, AgentPort, RunStore, and RunManager. An email account is a connection to a mailbox owned by an external provider. A trigger is a configured rule that turns an incoming event into a request to start work.
- The inspected checkout uses TypeScript, ESM, Node.js 20 or later, Vitest, a long running HTTP host, MCP tools, and separate stage worker processes. Use these existing patterns.
- AgentPort already provides the stage execution seam. RunStore already provides the run persistence seam. RunManager already accepts an inline task and applies execution checks. Email integration must reuse them.
- No general email or external trigger module was found in the inspected checkout. Do not assume the trigger setup discussed in the conversation exists on this branch. During implementation, reuse it if it has landed; otherwise add the smallest email trigger coordinator above RunManager.
- No domain glossary or relevant ADR was found in this checkout. Existing domain types and tests supply the vocabulary. Respect any relevant ADR added before implementation starts.

### Email module and test seam

- Keep one public email module seam, with two cohesive facets: EmailMailbox for operations and EmailEventSource for event lifecycle. Account management and normalized error types belong to that module's public interface.
- EmailMailbox provides testAccount, send, reply, getMessage, and search. EmailEventSource provides start with an asynchronous event consumer and stop. Starting twice must not create duplicate watchers. Stopping releases connections and prevents new event delivery after it resolves.
- LocalEmailAdapter implements the module with ImapFlow, Nodemailer, and MailParser. InMemoryEmailAdapter implements the same behavior for tests. RemoteEmailAdapter is a later implementation of the same seam.
- Keep IMAP sessions, SMTP transports, MIME parsers, OAuth exchange details, and remote transport details private. Do not expose separate protocol interfaces to pipeline code.
- The proposed seam extends the interface already agreed in this conversation. Its behavior, lifecycle, errors, and data ownership are part of the contract, not only its method names.

### Account configuration and access

- Store accounts in host configuration with an immutable accountId, display name, email address, enabled state, adapter selection, and selected receive folders. Use INBOX as the default receive folder.
- Local configuration includes IMAP and SMTP hosts, ports, TLS mode, usernames, secret references, optional approved sender aliases, optional sent folder, polling interval, and connection limits. Allow separate receiving and sending authentication settings.
- Require secure provider connections by default. Allow a clearly configured development exception for a local test mail server. Do not silently downgrade transport security.
- Initial authentication supports credentials or app passwords and externally supplied OAuth access tokens. The token configuration must state its expiry and refresh source, if one exists. A token without a refresh source must become an actionable authentication fault on expiry.
- Provider login screens, OAuth consent setup, and a complete token refresh platform are separate work. A company provider may disable password access or require OAuth. IMAP and SMTP connection settings alone do not bypass that requirement.
- Use a protected host secret store or injected secret references. Do not put secrets in stage YAML, task content, envelopes, tool results, or activity logs. Reuse credential storage conventions where suitable, but do not mix mailbox secrets into the model provider auth format.
- Limit account access to the current Stageflow installation or workspace scope. Include that scope in lookups and dedupe records. Hosted company tenancy is future work; this spec does not claim a full multi tenant platform.
- A stage declares permitted accountIds and operations. Resolve them before execution. Reject unknown or disabled accounts and attempts to use an undeclared account. Configuration is the authority; an email body or model instruction cannot add account access.
- Sender aliases must be configured and permitted by the provider. Do not allow an arbitrary From address supplied by an agent.
- Configuration changes restart only affected connections. Disabling or removing an account stops its watcher and blocks new operations. Do not reconnect a removed account from an old retry timer.

### Normalized message contracts

- Define EmailAddress, EmailMessageRef, EmailMessageSummary, EmailMessage, SendEmailInput, ReplyToEmailInput, SendEmailResult, SearchEmailsInput, SearchEmailsResult, EmailAccountStatus, EmailReceivedEvent, and normalized operation errors.
- EmailMessageRef contains accountId and an opaque adapter owned message identifier. It may include a folder label for display. The local adapter encodes mailbox, UIDVALIDITY, and UID in that identifier. Callers must not interpret them. This refines the earlier illustrative IMAP reference so future adapters need not expose IMAP concepts.
- Message references are account scoped. Retrieval validates the account and rejects stale references after mailbox identity changes. A Message-ID header alone is not a unique storage key.
- Summaries include reference, available Message-ID and thread identifier, From and To addresses, subject, received timestamp, unread and flagged state, attachment presence when known, and an optional bounded text preview. Do not invent a provider thread identifier when none exists.
- Full messages include normalized headers needed for replies, text content, optional HTML, Cc, Reply-To, and bounded attachment metadata. Fetch attachment content only through a bounded, explicit operation or the message retrieval options. Avoid inline unbounded binary data in agent tool results.
- Preserve absent or malformed optional headers as a clear missing value. Apply safe text decoding and consistent timestamp formats. Mailbox reads use non mutating fetch behavior and do not mark messages as read.
- Treat message content and attachments as external task data. Tool descriptions and trigger prompts must not treat that content as Stageflow configuration or privileged instructions.

### Search and list behavior

- A single search operation covers filtered lookup, recent message listing, and unread message listing. Do not add parallel listUnread or listBySender methods.
- Search accepts accountId, optional mailbox, text, from, to, subject, unread, flagged, hasAttachments, receivedAfter, receivedBefore, limit, cursor, and newest or oldest sort. A request with no filter lists messages. Default mailbox is INBOX; default sort is newest.
- All supplied filters combine with AND. An omitted unread or flagged filter means no restriction; false explicitly selects the opposite state. Address filters match parsed mailbox addresses without case distinctions. Subject matching is substring matching. Free text searches subject and body where supported. Date bounds use an inclusive lower bound and exclusive upper bound in UTC.
- An adapter must preserve these semantics. If its provider query is approximate, perform bounded filtering before returning results. If it cannot meet the contract within the configured work limit, return an unsupported or resource limit error rather than claim a complete result.
- Search returns summaries and an optional opaque nextCursor. It does not return full bodies or an exact total count. Default limit is 20; maximum limit is 100. Validate malformed cursors, date ranges, folders, and limits.
- Local and test adapters sort by mailbox arrival order (ascending provider UID for oldest, descending for newest). The received timestamp is used for date filters, not sorting. An imported message can therefore have an earlier received timestamp but appear first in newest order.
- The local adapter compares bounded envelope metadata directly. This avoids provider address substring and whole-day date approximations. It does not download message bodies for search. Each call inspects at most the account's `searchWorkLimit` eligible message candidates (default 1000, allowed 1–10000). Earlier pages and new arrivals are excluded before this work. If the adapter cannot establish a complete page and continuation state within that limit, it returns `EMAIL_RESOURCE_LIMIT`, with no partial results. The operator can update this account setting through the account management interface. UID search windows contain at most 100 possible identifiers. A bounded binary lookup skips sparse UID gaps without an unbounded result array.
- Both adapters support `flagged` through message flags. They reject `text` and `hasAttachments` with `EMAIL_SEARCH_UNSUPPORTED` and an `unsupportedFields` list. Account capability information lists the supported fields.
- Cursors have a signature and belong to the adapter instance that created them. A host restart or adapter replacement invalidates existing cursors with `EMAIL_INVALID_INPUT`; start a new search. Each continuation must use the same account, mailbox, filters, sort, and page limit. Date inputs must be complete timestamps with an explicit UTC offset. They are compared as UTC instants.
- Bind each cursor to account, query, sort, and folder generation. New messages must not cause repeated results in the same paginated traversal. Messages removed by another client can disappear from later pages. A changed mailbox generation invalidates the cursor.
- Initial required filters are from, to, subject, unread, and date range, plus sorting and pagination. Free text, flagged, and attachment filtering remain declared in the interface. Implement them where the adapter can meet the contract; otherwise report EMAIL_SEARCH_UNSUPPORTED with the unsupported fields. Do not use success with an empty list to mean unsupported.
- Report supported search fields in account capability information. Capability discovery does not replace runtime validation.
- Attachment presence is not a standard IMAP search key. Use bounded structure inspection when implemented. Do not fetch every message body in an unbounded mailbox scan.

### Sending and replying

- Send accepts accountId, recipient address lists, subject, text and optional HTML body, optional reply headers, and bounded attachments. Require at least one recipient. Return the operation identifier, message identifier when available, accepted and rejected recipients, and submission time.
- A successful receipt means the SMTP provider accepted submission. It does not prove recipient delivery. Partial recipient acceptance is explicit.
- Reply resolves the original message, prefers Reply-To over From, sets In-Reply-To and References when available, and uses reply subject conventions. Reply defaults to the sender only. Reply-all is an explicit option and excludes the sending account's own addresses.
- Accept a caller supplied operation key for send and reply. Reuse a recorded receipt for repeated completed operations with the same key and content. Reject reuse with different content.
- SMTP does not provide universal exactly once submission. If the connection fails after possible acceptance, return EMAIL_SEND_OUTCOME_UNKNOWN and retain an uncertain operation record. Do not automatically resend an uncertain submission.
- Do not promise that SMTP automatically creates a Sent folder copy. If a provider does not file one and the operator requires it, support an explicitly configured IMAP append policy. An append fault after SMTP acceptance must report submission success with a copy warning; it must not resend the message. Document the provider dependent behavior.
- Initial attachments use explicit artifact references with existing run access checks and configurable count and byte limits. Stream where possible. Reject oversized content before submission.

### Watcher lifecycle and incoming events

- One host owns each account and watched folder connection. Stage worker processes call the host email interface through the existing host interaction pattern or a narrow authenticated transport. Workers must not each start a mailbox watcher or receive raw secrets.
- Use IMAP IDLE for notification where available. Notifications signal a need to reconcile mailbox state; they are not complete message events. Use polling when IDLE is unavailable and periodic reconciliation to recover missed notifications.
- Persist progress per account and folder using UIDVALIDITY and a UID high water mark. On first connection, establish a baseline without emitting all historical mail. Historical replay is explicit and bounded.
- After a disconnect, reconnect with a new client, exponential delay, a maximum delay, and jitter. Reconcile all retained messages after the durable progress point before returning to IDLE. Do not advance progress past a message whose event has not been accepted durably.
- If UIDVALIDITY changes, record a mailbox reset and establish a new baseline. Do not interpret old UIDs as new message identities. Emit a health notice; use explicit replay if recovery is required. Messages deleted by the provider before reconciliation cannot be recovered.
- Emit email.received with a version, stable eventId, accountId, message reference, summary, received timestamp, and detection timestamp. The event consumer can retrieve the full message when required. This refines the earlier example with a complete message in the event and avoids durable body storage.
- Incoming delivery is at least once. The asynchronous consumer acknowledges only after event metadata is recorded durably. Use eventId to suppress repeated trigger dispatch. A failed consumer causes retry and does not silently advance the checkpoint.
- Initial runtime is the long running Stageflow host. A short CLI command does not keep receiving email after it exits. Document that the host must be running for detection and dispatch.

### Trigger rules and execution integration

- An email trigger includes triggerId, enabled state, accountId, folder, rule version, sender criteria, subject criteria, and target information. Initial matching supports exact sender address and subject contains, without case distinctions. All configured conditions must match.
- Target a catalog pipeline with a validated task template. Reuse RunManager for start requests, catalog validation, capacity limits, checkout leases, and normal run state. Do not invoke agents by creating a separate execution loop.
- Where an existing standalone agent entry point is available, target it through its normal execution interface. In this checkout, a one stage pipeline is the initial focused agent target. A new standalone agent host is out of scope.
- Build an inline task with the operator's configured goal and bounded email context. Include eventId, triggerId, accountId, message reference, sender, subject, and timestamp as provenance. Full bodies are fetched only if the template requires them. Do not interpolate raw headers into executable configuration.
- Record event metadata and per trigger dispatch status durably. Use a unique key based on installation scope, eventId, triggerId, and rule version. Duplicate delivery of the same event must not start the same trigger twice. Two matching triggers may each start one run.
- The transition from pending dispatch to created run must be crash safe. Prefer a dispatch key accepted by the existing run creation path, with a uniqueness constraint and a retrievable runId. A pending flag alone cannot prevent a duplicate after a crash between run creation and acknowledgement.
- Retry temporary capacity and checkout conflicts with bounded delay. Retain pending metadata while waiting. Configuration or validation failures become actionable failed dispatches rather than infinite retries. Bound pending work and surface queue saturation.
- Enabling or editing a rule applies to future detected events. Replay of earlier events requires an explicit action. Account disconnection must not be used to accidentally replay the whole mailbox.
- Process messages per watched folder in a consistent order, but do not promise global ordering across accounts. Pipeline run duration does not block mailbox detection; the event consumer records dispatch intent before execution completes.

### Persistence and activity

- Store account definitions and secret references, connection health, progress checkpoints, a bounded event metadata ledger, dispatch status and runId, and send operation receipts. Use existing host storage conventions and migrations where suitable.
- Persist enough metadata to recover trigger work after restart. Do not maintain a full message body, MIME, attachment, or searchable mailbox database.
- Normal run records can retain the bounded email context deliberately supplied to a task. This is run provenance, not a mailbox mirror. Document this distinction.
- Define retention for completed event and operation metadata. Retain unresolved pending or uncertain operations until resolved. Use checkpoints and dispatch uniqueness to protect against duplicate processing; do not rely only on a short in memory cache.
- Show account health and operation outcomes through a minimal host management surface. An optional plain sent or received list shows summaries or operation metadata. A complete email UI is not required for initial acceptance.
- Use normalized errors for invalid input, account not found or disabled, unauthorized account use, authentication failure, connection failure, timeout, rate limit, message not found, stale reference, unsupported search, resource limit, and unknown send outcome. Include retryable state and safe context, without secrets or full provider responses.

### Replacement with an external email process

- Adapter selection occurs in configuration and dependency composition. Stage definitions, pipeline prompts, query inputs, and trigger rules do not contain IMAP, SMTP, MCP, or remote endpoint details.
- RemoteEmailAdapter later maps EmailMailbox operations to authenticated HTTP or MCP calls. Prefer a small HTTP command interface for host integration; MCP can expose the same operations to direct agents when useful.
- Receive events through a versioned signed webhook contract, with event identity, replay protection, account mapping, and acknowledgement after durable acceptance. Continuous incoming delivery must not depend on an agent keeping an MCP tool call open.
- A Mail MCP deployment must implement watcher, replay, and webhook behavior before it can replace the local incoming adapter. Existing send and read tools alone do not satisfy this spec.
- Message references remain valid only within their originating adapter. During migration, preserve a ref mapping or return an explicit stale reference error. Do not assume a local UID reference works remotely.
- Switch accounts in a controlled cutover. Stop the old watcher, reconcile its progress, import progress or dedupe identity where supported, start the replacement, and verify events. Keep rollback configuration. Do not leave two active watchers dispatching independently.
- Run the same contract suite against the replacement before switching it on. The first release builds the seam and local adapter; it does not deploy Mail MCP.

## Testing Decisions

- A good test calls the same public interface as an agent or trigger and checks observable behavior. Do not assert internal ImapFlow calls, MIME parser methods, transport class structure, or incidental log wording.
- Use the email module as the primary new test seam. Run shared EmailMailbox and EmailEventSource contract tests against the in memory adapter and the local adapter with a controlled IMAP and SMTP fixture. Add the remote adapter to that suite when implemented.
- Use existing AgentPort, RunStore, and RunManager seams for integration tests. Prior art includes agent port contract tests, run store adapter contract tests, inline task run tests, capacity tests, stage worker tests, HTTP host tests, and MCP tool tests.
- Prove configuration isolation: separate accounts, secret redaction, disabled accounts, declared stage permissions, approved sender identities, and account changes without duplicate watchers.
- Prove send and reply behavior: validation, provider acceptance, partial rejection, thread headers, explicit reply-all, attachment limits, repeated operation keys, conflicting keys, and uncertain SMTP outcomes without automatic resend.
- Prove search behavior: unfiltered listing, unread true and false, combined filters, date edges, default and maximum limits, sort order, cursor progression, concurrent mailbox changes, unsupported filters, stale cursors, and provider normalization.
- Prove that search and retrieval preserve provider unread flags. Prove that a normal email application can still read the same messages.
- Prove watcher behavior with several messages per notification, polling fallback, restart catch-up, consumer failure, malformed message handling, account isolation, stop behavior, and UIDVALIDITY reset. Use controlled clocks or fixture events, not real time sleeps.
- Prove trigger behavior at the run creation seam: matching and nonmatching rules, bounded task context, valid one stage target, two independent matching triggers, duplicate event delivery, capacity and checkout retry, invalid target, and restart recovery.
- Inject a crash between dispatch intent and run creation, and between run creation and acknowledgement. Both cases must recover without starting a second run for the same dispatch key.
- Prove initial connection creates no historical runs, while an explicit bounded replay creates the expected runs.
- Prove host and stage worker integration does not expose credentials to the worker and does not create per stage watchers.
- Use an opt-in provider smoke test with dedicated credentials to check connection, send, provider receipt, search, incoming trigger, and reply threading. Keep it outside ordinary test runs. Do not use real company inboxes in automated tests.

## Out of Scope

- Hosting email domains, provisioning email addresses, changing MX records, or operating a full mail server such as Mailu or Stalwart.
- A paid connector subscription as a required production dependency.
- Integrating a general workflow application solely to obtain an email connector.
- A complete email client UI, mailbox synchronization database, full text index, durable attachment archive, or replacement for Gmail and Outlook.
- Delete, archive, move, label, and mark-as-read agent operations in the first release.
- Full OAuth onboarding, provider app registration, native Gmail or Microsoft Graph adapters, and automatic discovery for every provider.
- Arbitrary mailbox scans with no limits, complex rule languages, and attachment content triggers.
- Building or deploying RemoteEmailAdapter or modifying Mail MCP in the first release. The interface and migration plan are required now.
- A new standalone agent execution system or a complete hosted company tenancy model.
- Guaranteed recipient delivery, universal exactly once SMTP submission, and recovery of messages deleted before Stageflow can read them.

## Further Notes

- This document records the agreed product direction and proposed defaults. Numerical limits, configuration naming, and storage placement can be adjusted during implementation if public behavior remains clear and tests cover the adjustment.
- Deliver the feature in vertical slices: account connection and non destructive testing; agent send, reply, get, and core search; watcher lifecycle and durable events; trigger dispatch through RunManager; host and worker integration; recovery and operational documentation. Each slice must work through the public email seam.
- The first useful release must connect an existing inbox, let an authorized stage send and search email, and start a configured pipeline from a new matching message. Interface declarations without this behavior do not complete the feature. Optional search filters may report unsupported until implemented.
- The spec must not be read as evidence that every provider allows IMAP or SMTP, that SMTP files sent messages automatically, or that existing Mail MCP projects already emit trigger events. Validate those capabilities for the selected account and replacement adapter.
- Relevant upstream projects from the research are [ImapFlow](https://github.com/postalsys/imapflow), [Nodemailer](https://github.com/nodemailer/nodemailer), [MailParser](https://github.com/nodemailer/mailparser), and the possible later [Mail MCP adapter target](https://github.com/tecnologicachile/mail-mcp). The remote target is optional; the Stageflow interface is the stable decision.
- Keep this repository document as the canonical spec and publish its content to the project's GitHub issue tracker with the ready-for-agent label. Update both records when accepted requirements change.
