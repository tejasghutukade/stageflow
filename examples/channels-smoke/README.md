# Channels smoke test

One stage sends one email (AgentMail) and one text (iMessage via Photon) through the connections on the Connections page. Nothing is sent until you start a run.

1. Connect AgentMail and iMessage on the Connections page. The stage expects the connection ids `agentmail` and `imessage`; if yours differ, edit `connection:` in `send-test-messages.yaml`.
2. In `send-test-messages.yaml`, replace the two pinned recipients: `to: [change-me@example.invalid]` (your email) and `to: "+10000000000"` (your phone in E.164 form, for example `+14155550123`). On a Free or Pro Photon project the phone must be a registered user of the project, or the run is blocked at start with `channel_check_failed`.
3. Change `model:` to one you have a provider for.
4. Run `sf validate` on the pipeline, then open `channels-smoke` in the console and start it with `channels-smoke-task`. The run checks both connections live before the stage starts.

The Claude agent backend does not provide `send_message`; use a Pi model (the default).

The email subject is `Stageflow channels test`. The agent cannot change recipients. A message that may have been sent is never resent: if a call returns `CHANNEL_SEND_OUTCOME_UNKNOWN`, check the provider before running again.
