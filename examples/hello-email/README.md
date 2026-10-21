# Hello email test

One stage sends one email from the `personal-inbox` account. No trigger is created.

1. Edit the root `email.yaml`: replace the address and both usernames with your email address. The template uses Gmail; other providers can use their own IMAP and SMTP settings.
2. Supply `PERSONAL_EMAIL_PASSWORD` in the host environment. For Gmail, use an app password, not your normal Google password. Do not store it in YAML.
3. Set `enabled: true` and restart the host so it reads the file and credentials.
4. Edit `hello-email.task.yaml`: set `input.recipient` to the destination email address. The empty default prevents a run from starting before you choose it.
5. Open the `hello-email` pipeline in the console and start it with `hello-email-task`. The stage uses `cursor/auto`; change its model if you use another configured provider.

The subject is `Hello from Stageflow`. The body is `Hello! This email was sent by my Stageflow test pipeline.` The stage reports the SMTP receipt and does not read the inbox.

Every new run can send a new email. The same operation key protects repeated tool calls within one run and stage. Do not retry an uncertain submission under a new key or run until you inspect the provider.

The local `email.yaml` is ignored by Git. `email.example.yaml` remains the public single-account template. Inbox monitoring starts when the long-running host starts; SMTP connects when the stage sends. No email is sent during startup.

## Incoming-email reply test

The `hello-email-reply` pipeline has one stage, `reply-hello-email`. An account email rule with `includeBody: true` supplies the incoming message reference and up to 8192 characters of body in task context. The stage checks the sender and Reply-To, interprets the latest authored text (ignoring quoted history and signatures), then sends one threaded conversational answer. It does not reuse the manual send task or require its recipient input. Its test sender is `simrankore15@gmail.com`.

Send `Tell me a joke` in the email body to receive a joke. Send `What day is today?` to receive the weekday and date checked against the host clock, with its timezone. Each new incoming message starts a separate run; no conversation memory beyond that message is loaded. Empty or truncated requests are skipped. The stage prompt limits email requests to conversational answers: it does not authorize browsing, file changes, commands from the email, or access to secrets. These are prompt-level boundaries, not a hardened sandbox for arbitrary untrusted senders.

The email rule is stored by the account connector at `/api/email/triggers`, not by the separate generic trigger catalog. Both are visible on the console's Triggers page. Email rules show their inbox and filters; Open displays their details. They cannot be fired manually because they require an incoming message. New messages are handled after the rule is enabled; old messages are not replayed. Each message/rule version has one durable dispatch claim. Marked automatic or bulk messages cannot be replied to through `reply_email`. Outgoing emails carry `Auto-Submitted` and `X-Auto-Response-Suppress` headers. These guards reduce automatic reply loops, but cannot identify every unmarked automated sender.
