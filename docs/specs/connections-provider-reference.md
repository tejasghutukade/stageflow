---
status: reference
---

# Reference: provider setup facts for Connections

Companion to [connections-spec.md](connections-spec.md). This file records what each provider's own documentation says, so an implementing agent does not have to re-research it or guess.

- Research date: 2026-10-13. Provider docs change. Re-check the linked page before relying on a detail.
- **Verified** means read in the provider's public docs on that date. **Not verified** items are listed at the end. Do not treat them as fact.
- Photon docs have Stable and Beta versions. Everything here is **Stable** (the default). Do not mix Beta examples in.

## AgentMail

Docs: <https://docs.agentmail.to/> (index for tools: <https://docs.agentmail.to/llms.txt>)

**What it is.** An API-first email service that gives each agent its own inbox. Inboxes are created through the API, unlike Stageflow's existing email provider, which only connects mailboxes that already exist.

**Auth and endpoints** (verified)
- Base URL `https://api.agentmail.to/v0/`. EU region: `https://api.agentmail.eu`.
- Bearer API key (`am_...`), generated in the AgentMail Console.
- Keys can be limited. Inbox-scoped keys only reach one inbox's threads, messages and drafts. Keys also carry granular permissions (`inbox_read`, `inbox_create`, `message_read`, `message_send`, `webhook_create`, `domain_create`, and more). When permissions are omitted, all are granted.
- SDKs: `npm install agentmail` (TypeScript), `pip install agentmail`. Also a CLI (`agentmail-cli`), SMTP for sending, and an MCP server.

**Inboxes** (verified, `docs.agentmail.to/inboxes`)
- `inboxes.create({ username?, domain?, displayName?, clientId?, metadata? })`. All fields optional. With none, AgentMail generates an address on the default domain `agentmail.to`.
- `domain` can be a verified custom domain, or a subdomain of a domain that has subdomains enabled.
- `clientId` makes creation idempotent. Use it so retries do not create duplicates.
- Also `get`, `list({limit, pageToken})`, `update({displayName?, metadata?})`, `delete`.
- `metadata` is a key-value bag (max 256 keys). Use it to store the Stageflow connection ID on the inbox.

**Custom domains** (verified, `docs.agentmail.to/domains`)
- Three steps: create the domain via API or Console, copy the returned DNS records into your DNS provider, wait for verification. A `domain.verified` webhook event exists.
- The design's hint ("Use your own domain after verifying it") reflects this. There is no designed UI for adding or verifying a domain. Decide with the owner before building one.

**Receiving mail**
- **WebSocket** (verified, `docs.agentmail.to/websockets`): persistent connection. No public URL, no ngrok, outbound only. After connecting, send a `Subscribe` with `inbox_ids`, then read events such as `MessageReceivedEvent`. Best default for a local host.
- **Webhooks** (verified, `docs.agentmail.to/webhooks`): AgentMail POSTs to a URL you register. Needs a public URL. Ten event types including `message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected`. Spam, blocked and unauthenticated messages are **excluded by default** and need explicit `event_types` plus label permissions. Custom delivery headers are supported for authenticating deliveries.
- Reply extraction fields `extracted_text` and `extracted_html` strip quoted text. Threading uses standard email headers.
- IMAP is listed as "coming soon". Do not build the AgentMail provider on IMAP.

**Sending** (verified): send, reply, reply-all, forward, drafts, attachments (base64), labels, scheduled send.

**Design mapping**
- API key field with live "Valid" check: call a cheap authenticated read such as `inboxes.list({limit:1})`. The designs' hint says an inbox-scoped key also works. If so, `list` may be forbidden, so choose a check the key's permissions allow, or handle 403 as "valid but limited".
- "Create new / Use existing" toggle maps to `inboxes.create` vs `inboxes.list` plus select.
- "WebSocket / Webhook" toggle maps to the two receive modes above.

## Slack (native app, Socket Mode)

Docs: <https://docs.slack.dev/apis/events-api/using-socket-mode>, <https://docs.slack.dev/authentication/installing-with-oauth>

**Why this design.** Socket Mode lets the app receive events over a WebSocket, so Stageflow needs no public URL. The user creates their own Slack app, so there is no central Stageflow OAuth app and no hosted redirect.

**Setup, as Slack documents it** (verified)
1. Create an app, optionally from a manifest. Example manifest fields: `features.bot_user.display_name`, `oauth_config.scopes.bot`, `settings.event_subscriptions.bot_events`, `settings.socket_mode_enabled: true`.
2. Toggle on Socket Mode in app settings.
3. Generate an **app-level token** (Basic Information, App-level tokens).
4. Install the app to the workspace, which yields the **bot token** (`xoxb-`).

The WebSocket URL is not static. It is created at runtime by calling `apps.connections.open`, and it refreshes regularly. Use Slack's SDK (Bolt, or `@slack/socket-mode`) rather than hand-rolling this.

**Constraints** (verified)
- Socket Mode apps cannot be listed in the public Slack Marketplace. Fine for an operator's own workspace.
- Socket Mode requires granular (non-classic) permissions.
- Switching on Socket Mode while events are flowing can drop events until the socket connects.

**Scopes used in the design** (each verified on its `docs.slack.dev/reference/scopes/` page)
- `app_mentions:read`: view messages that directly mention the app in conversations the app is in.
- `im:history`: view messages in direct messages the app has been added to. Pairs with the `message.im` event.
- `chat:write`: send messages as the app.
- Bot events: `app_mention`, `message.im`.

**Not verified**
- The app-level token needs the `connections:write` scope. That is standard Slack behaviour, but the excerpt I read was cut off before the token section. Confirm at `docs.slack.dev/apis/events-api/using-socket-mode` (heading "Generate an app-level token").
- That the bot must be invited to a channel before it sees mentions there. The scope descriptions say "in conversations that the app is in", so this is a reasonable inference, not an explicit rule.
- Reading arbitrary channel messages (not just mentions) needs more scopes (for example `channels:history`). The design intentionally does not request them.

**Workspace detection.** The design shows "Detected workspace acme-corp · bot @stageflow-agents" after the bot token is pasted. That implies calling `auth.test` with the bot token. `auth.test` was not read in the docs for this task. Verify it returns team name and bot user before building.

**Alternatives deliberately not used**
- Slack OAuth install flow (`https://slack.com/oauth/v2/authorize`) needs a redirect URL and a client secret exchange. Not suited to a local host.
- The "Agents and AI Apps" feature (`assistant:write`, split-pane view) is optional Slack UI. Not in scope.
- Photon's Slack platform: Photon's cloud API has Slack endpoints (`/projects/{id}/slack/setup` takes a workspace-admin config token `xoxe.xoxp-...`; `/slack/tokens` issues per-workspace tokens; returns 403 if the project has not enabled the Slack platform). The Spectrum SDK provider docs do not list Slack as supported today. Revisit if the owner wants Slack under the Photon credential.

## Photon Spectrum (iMessage, WhatsApp Business, Telegram)

Docs: <https://photon.codes/docs/spectrum-ts/introduction>, index <https://photon.codes/docs/llms.txt>

**Model** (verified)
- One Photon **project** has a project ID and project secret ("PROJECT_ID" and "SECRET_KEY" under project Settings in the dashboard at `app.photon.codes`). SDK reads them from `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` if not passed.
- The SDK is `spectrum-ts`. `Spectrum({ projectId, projectSecret, providers: [...] })` merges every provider into one `app.messages` stream. Each message carries `message.platform`. Scoped packages exist (`@spectrum-ts/core`, `@spectrum-ts/imessage`).
- Platforms supported today: iMessage, WhatsApp Business, Telegram, terminal, and SIP voice calls on iMessage lines. Discord, websites, apps and others are described as future.
- Platforms are switched on per project in the Photon dashboard (and through their API's `platforms` operations). This is why the WhatsApp dialog tells the user to enable it there first.
- Provider config can come from env vars named `SPECTRUM_<PROVIDER>_<KEY>`. Explicit config wins.

**Design consequence.** Store the Photon project as one `ProviderCredential` and let iMessage, WhatsApp and Telegram connections reference it. The picker footer, the iMessage note, and the WhatsApp and Telegram "saved from your iMessage connection" rows all depend on this.

### iMessage

Docs: <https://photon.codes/docs/spectrum-ts/providers/imessage>, <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>

- **Cloud** (`@spectrum-ts/imessage`, platform id `imessage`): authenticates to Spectrum Cloud, connects to managed lines over gRPC. `imessage.config()` with no arguments discovers **every line owned by the project** and renews tokens automatically at 80% of their TTL. Passing explicit `clients` restricts to a subset, but then tokens are **not** renewed by Spectrum.
- **Plan decides line type** (verified table):
  - Free or Pro: shared pool. Each person is routed through a number from a shared pool, which may differ per person. **No group creation and no group-change events.**
  - Business: dedicated line(s) owned by the project. Group creation and group events supported. Optional per-phone routing (`phone` space parameter) and opt-in auto-scale.
- Shared vs dedicated is therefore not something Stageflow's user picks. The dialog shows it read-only. Do not show a "token expiring" warning for automatic discovery.
- **Local** (`@spectrum-ts/imessage-local`, platform id `local_imessage`): reads this Mac's Messages database (`~/Library/Messages/chat.db`). macOS only, needs the process to have **Full Disk Access**, host must be signed in to Messages, **no Photon credentials**. Bun uses built-in SQLite; Node uses `better-sqlite3`. Install it only on the Mac, never in a cloud deployment.
- Feature comparison cloud vs local (verified): text, attachments, contacts, existing DMs and groups work in both. Reactions, replies, edits, unsend, sending read receipts, effects, inbound read receipts, backgrounds, iMessage Apps, and native contact-card sharing are **cloud only**. Typing is a no-op locally; streaming text is unsupported locally. Rename, avatar and membership changes are dedicated-line only.
- Both can be registered in one `Spectrum()` instance because their platform ids differ.
- The older `photon-hq/advanced-imessage-kit` repo is marked unmaintained in favour of Spectrum. Do not use it.

### WhatsApp Business

Docs: <https://photon.codes/docs/spectrum-ts/providers/whatsapp-business>, setup page `.../providers/whatsapp-business/setup`, low-level kit <https://photon.codes/docs/advanced-kits/whatsapp/getting-started>

- Wraps the official WhatsApp Business Cloud API. **1:1 conversations only.** Group management is not exposed and `space.create([a, b])` throws.
- Two modes (verified on the setup page):
  - **Direct mode:** `whatsappBusiness.config({ accessToken, phoneNumberId, appSecret })`. Env fallbacks `SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN`, `..._PHONE_NUMBER_ID`, `..._APP_SECRET`. `accessToken` is a permanent or system-user token. `appSecret` verifies webhook payload signatures.
  - **Cloud mode:** uses the Photon project credentials. Discovers every WhatsApp line owned by the project, and re-mints tokens on a schedule. A line added while the app runs is picked up at the next renewal. Restart to pick it up immediately. A partial set of direct-mode env vars silently falls back to cloud mode.
- **Spectrum Cloud one-click** (verified, low-level kit page): sign up at `app.photon.codes`, toggle WhatsApp on in the project, finish the guided config, copy credentials.
- **Bring your own Meta app** (verified, same page):
  1. Create an app at developers.facebook.com and add the WhatsApp product.
  2. Under WhatsApp, API Setup, copy `phone_number_id`.
  3. Generate a **permanent** token through a System User (the 24-hour token on API Setup is not suitable for production). Scopes: `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`. Assign the app (Manage app) and the WhatsApp account (Manage WhatsApp Business Accounts) to the system user.
  4. Under App Settings, Basic, copy the `app_secret`.
  5. Under WhatsApp, Configuration, set the webhook: callback URL `https://whatsapp-business.spectrum.photon.codes/webhook`, verify token can be anything (the handshake always returns the challenge), subscribe to the `messages` field.
  - Photon states the webhook endpoint is free, public and shared, and that it does not persist your access token or app secret.
- Photon's API issues per-line tokens: `POST https://spectrum.photon.codes/projects/{projectId}/whatsapp-business/tokens` with `Authorization: Basic base64(projectId:projectSecret)` returns `auth` (Meta phone_number_id to token), `numbers` (phone_number_id to display number, nullable), `expiresIn`. This is the source for the design's "WhatsApp numbers on this project" list.

### Telegram

Docs: <https://photon.codes/docs/spectrum-ts/providers/telegram>, setup page `.../providers/telegram/setup`

- Config: `telegram.config({ botToken })`. Optional `webhookSecret` (verifies webhook payloads) and `baseUrl` (defaults to `https://api.telegram.org`). Env fallbacks `SPECTRUM_TELEGRAM_BOT_TOKEN`, `..._WEBHOOK_SECRET`, `..._BASE_URL`.
- Bot token comes from @BotFather.
- Inbound messages arrive through **Fusor webhooks**, outbound through the Bot API. In **cloud mode** (projectId and projectSecret supplied), the provider **registers its Fusor webhook automatically on startup**. In local or direct mode the user registers the webhook through the Telegram Bot API.
- Supports text, media, reactions, replies, typing indicators, edits, lazy media downloads.
- Telegram still needs the Photon project (cloud mode) **and** a bot token. The designs show both.

### Photon API (for implementation)

Base `https://spectrum.photon.codes` (OpenAPI at `/openapi/json`). Tags seen: billing, imessage, lines, platforms, users, voice, webhooks, whatsapp-business, slack. Token issuing for iMessage (`/projects/{projectId}/imessage/tokens`) returns either `type: "dedicated"` (per-instance tokens plus `numbers`) or `type: "shared"` (single token). That `type` is a direct, documented way to tell which plan the project is on, and is how the iMessage dialog can show "Shared pool" vs "Dedicated" read-only.

## Not verified (do not assume)

- Photon Business pricing or limits. The designs cite "Photon Business" only because the docs name it as the dedicated-line plan.
- How Photon's `platforms` and `lines` API endpoints behave in detail (enabling a platform from Stageflow, enumerating lines). Only the token endpoints and the Slack setup endpoint were read in full.
- Whether one Stageflow host can run several `Spectrum()` instances, or must run exactly one with all providers merged. The SDK examples show one instance with several providers. This affects how Stageflow wires several Photon-backed connections. **Verify before designing the lifecycle code.**
- Whether a user can have several Photon projects. The designs assume one saved project, with a "Use another project" escape hatch.
- Slack `connections:write` and `auth.test` details (see Slack section).
- AgentMail pricing, rate limits, and whether `inboxes.list` works with an inbox-scoped key.
- WhatsApp conversation-window or template-message rules imposed by Meta. They affect whether an agent can reply to a user after some time. Not researched.
- Telegram group chats and bot privacy-mode behaviour. Not researched.
- Whether using Photon's shared WhatsApp webhook is acceptable for the owner's data-handling needs. Photon states it does not persist the token or secret. That is Photon's claim, not independently checked.

## Spike results for the send path (2026-10-13)

Research for the send-only phase. Sources: provider docs, plus a **static read** of the published `spectrum-ts` 12.10.1 packages (`@spectrum-ts/core`, `imessage`, `whatsapp-business`, `telegram`) downloaded with `npm pack` and read, never installed or run. Nothing here was exercised against a live account. Items marked **third-party** come from non-official pages and should be re-checked.

### Photon iMessage

- **Supported proactive send path (verified, docs):** `imessage(app).user("+1…")` then `im.space.create(user)` then `space.send(text)`. No inbound event is needed. DM only on shared-pool plans.
- **Recipient allowlist on Free/Pro (verified, Photon troubleshooting page):** a shared line only messages recipients registered as users of the project. Anything else fails with `Target not allowed for this project`. Business dedicated lines are exempt. Users are managed in the Photon dashboard or through the API: `GET /projects/{projectId}/users/?search=<phone>` (Basic auth) and `POST /projects/{projectId}/users` with `type: "shared"` and `phoneNumber` (E.164). This gives a **documented live check** for "is this pinned recipient allowed". A third-party page (Hermes agent docs) says shared lines can only message a number after it texted the line first. That differs from Photon's own page. Treat Photon's page as authoritative and confirm with a real send.
- **Quotas (verified):** 5,000 messages per server per day. 50 new conversations per line per day (first message to a recipient the line never contacted). Photon also warns that unsolicited outreach can get lines flagged and says to contact only opted-in recipients.
- **Low-level client address (from SDK source, undocumented):** the cloud package connects to `${instanceId}.imsg.photon.codes:443` for dedicated lines (token from `POST /projects/{id}/imessage/tokens`), and `imessage.spectrum.photon.codes:443` (override env `SPECTRUM_IMESSAGE_ADDRESS`) for shared. The documented low-level kit (`@photon-ai/advanced-imessage`) takes `address` and `token`, but no public page says how to derive them from project credentials. **Do not build on the derived addresses.** Use the `spectrum-ts` SDK.
- **`Spectrum()` init behaviour (partly resolved):** the iMessage `createClient` mints tokens from the cloud API and builds gRPC clients (and registers a "profile sync gate"). The inbound message streams are built by the provider's `messages` function. The docs say `app.webhook()` "never opens the streaming connection", which implies the stream is separate from init. **I could not find where the core runtime starts the stream, so whether a send-only `Spectrum()` opens inbound streams is still unconfirmed.** Resolve with a smoke test on real credentials: create the app, send one message, watch for open streams or inbound events. Always pass no `telemetry` (default off) so nothing is sent to Photon's OTLP endpoint.
- **Live-check candidates:** the token endpoint (`POST /projects/{id}/imessage/tokens`) proves the project credentials work and returns `type: "shared" | "dedicated"`. The users endpoint proves the recipient is allowed.

### WhatsApp (Photon provider and Meta)

- **Template rule (verified in the SDK source comment, corroborated by third-party Meta-rule write-ups):** free-form messages are only accepted inside the 24-hour customer-service window, which opens when the user messages the business. Outside it, free-form fails with Meta error **131047**, and only an **approved template** can be sent. Your own outgoing message, including a template, does not open the window; the user's reply does. **A pinned, stage-initiated send to a number that has not messaged you in the last 24 hours will fail unless it is a template.**
- **Provider support:** `@spectrum-ts/whatsapp-business` exports `whatsappTemplate({ name, languageCode, bodyParams? })`. v1 covers body text parameters only (`{{1}}…{{n}}`). Header and button components are not supported yet. The send path calls `messages.send({ to, template: { name, languageCode, components } })`.
- Cloud mode mints per-line tokens from `POST /projects/{id}/whatsapp-business/tokens`.
- Not read from Meta's own docs (blocked or not fetched): current pricing, per-number sending limits, template approval time. Template pricing and quality ratings can pause a template.

### Telegram

- **Platform rule (third-party, consistent across sources; Telegram's own docs not read):** a bot cannot start a private chat with a user. The user must message or `/start` the bot first. Otherwise Telegram returns `403 Forbidden: bot can't initiate conversation with a user`. Groups and channels work if the bot is a member (channels need posting rights, not verified). Knowing a user's ID or phone number does not grant permission.
- **Spectrum provider (SDK source):** sends via the Bot API (`sendMessage`, base URL default `https://api.telegram.org`). It can create only a single-user private chat or reference an existing chat with `space.get(chatId)`. It uses `getChat` and `getWebhookInfo`, which are usable as live checks.
- **Side effect to avoid (SDK source):** in cloud mode the provider **registers a Fusor webhook at startup**: it reads `getWebhookInfo` and calls `setWebhook` to point the bot at Photon's edge if the URL differs. A send-only Stageflow host would therefore **repoint the bot's webhook**, which could break any other service already using that bot. Decide whether that is acceptable before using Spectrum for Telegram. The plain Bot API for sending has no such side effect.

### Slack send path

- `chat.postMessage` (verified): bot scope `chat:write` required. `channel` is "an encoded ID or channel name that represents a channel, private group, or IM channel". Optional `thread_ts`, `blocks`, `markdown_text`, `username`.
- `chat:write.public` (verified): lets the app post to **public channels it is not a member of**. Needs `chat:write` too. Without it the bot must be a member.
- `im:write` (verified): "start direct messages with people". It authorizes `conversations.open`. Posting to a person therefore needs an IM channel ID from `conversations.open` first (the exact `users` arguments were not read).
- `auth.test` (verified): no scopes needed. Success returns `url`, `team`, `team_id`, `user`, `user_id` and, for bot tokens, `bot_id`. Failure returns `ok:false` with errors such as `invalid_auth` or `not_authed`. It proves the token is valid. **It does not prove `chat:write` or channel access**, so a run-start check cannot know whether a particular channel is postable. Optionally add a cheap channel-info call, but its scope needs were not researched.
- `@spectrum-ts/slack` **exists** in `spectrum-ts` 12.10.1 (a dependency of the umbrella package, and `slack` appears in Photon's platform-narrowing docs). This corrects an earlier note that Slack was not in the SDK. The owner chose native Slack. Its config and Slack setup under Photon were not read.

### AgentMail send path

- `POST /v0/inboxes/{inbox_id}/messages/send` (verified). Body fields: `to`, `cc`, `bcc` (string or list), `reply_to`, `subject`, `text`, `html`, `labels`, `headers`, `attachments`, `track_opens`. **`subject` is optional in the API.** Response `{ message_id, thread_id }`. Whole request including attachments is limited to 6 MB. Attachments by URL are about 30 MB total.
- `GET /v0/inboxes/{inbox_id}` returns `email`, `display_name`, `inbox_id`, `metadata`. Good live check. Whether an inbox-scoped key can call it was not verified.
