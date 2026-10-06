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
