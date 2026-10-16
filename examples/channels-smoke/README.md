# Channels smoke test

Two stages, one channel each: `send-email` sends one email (AgentMail) and then `send-text` sends one text (iMessage via Photon), through the connections on the Connections page. A stage can use one channel, so the two are separate stages. Nothing is sent until you start a run.

This example is **excluded** from the repo-root catalog manifest (see `stageflow.yaml`) so host-only Connections do not fail `sf validate --strict` or release CI. It remains loadable by explicit path.

1. Connect AgentMail and iMessage on the Connections page. The stage expects the connection ids `agentmail` and `imessage`; if yours differ, edit `connection:` in the two stage files.
2. Pin your recipients: in `send-email.yaml` replace `to: [change-me@example.invalid]` with your email, and in `send-text.yaml` replace `to: "+10000000000"` with your phone in E.164 form (for example `+14155550123`). On a Free or Pro Photon project the phone must be a project user, and that person must have texted their assigned Photon line once, or the send is rejected.
3. Change `model:` to one you have a provider for.
4. From the repo root, validate and run by path (Connections must already exist):

```bash
sf validate --strict --pipeline examples/channels-smoke/channels-smoke.pipeline.yaml
sf run \
  --pipeline examples/channels-smoke/channels-smoke.pipeline.yaml \
  --task examples/channels-smoke/channels-smoke.task.yaml
```

Or open the console and start `channels-smoke` with `channels-smoke-task` after loading the pipeline by path. The run checks both connections live before the stage starts.

The Claude agent backend does not provide `send_message`; use a Pi model (the default).

The email subject is `Stageflow channels test`. The agent cannot change recipients, and declaring a second channel on either stage is rejected. A message that may have been sent is never resent: if a call returns `CHANNEL_SEND_OUTCOME_UNKNOWN`, check the provider before running again.
