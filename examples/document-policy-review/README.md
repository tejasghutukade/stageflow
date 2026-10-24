# Document policy review

A generic compliance agent. It reads company policies in `policies/` and compares a document you name or paste. Swap the markdown in `policies/` and `documents/` for your own; the agent definition does not mention a particular control framework.

The chat page is part of the Stageflow host:

`http://127.0.0.1:3849/chat/policyreviewdemo1` (this worktree uses `docker-compose.policy-review.yml` because port 3847 is often taken locally)

Try:

- `Compare documents/acme-vendor-sow.md to our policies.`
- `Compare documents/support-runbook.md to our policies.`
- Paste a short contract clause and ask whether it meets `policies/vendor-security.md`.

`documents/acme-vendor-sow.md` conflicts with data handling, vendor security, and acceptable use (indefinite retention, no independent audit, a shared password written in the file, personal email, reuse for third-party models). `documents/support-runbook.md` follows those policies.

## Docker

From the repository root, with `OPENROUTER_API_KEY` or `STAGEFLOW_PROVIDER_OPENROUTER_API_KEY` set:

```bash
docker compose -p policy-review -f docker-compose.yml -f docker-compose.policy-review.yml up -d --build
```

Compose bind-mounts this directory at `/catalog/document-policy-review` and registers it with `STAGEFLOW_ENSURE_PROJECT_ROOTS`, so the agent is available when the host starts. The console lists it under Agents. The model is `openrouter/nvidia/nemotron-3.5-lightning:free`.

`docker-compose.policy-review.yml` publishes the host on **3849** (when 3847 is already in use) and runs the process as the `stageflow` user so email state under `/data` can be created on first boot.

## Files

| Path | Role |
|------|------|
| `agents/compliance.agent.yaml` | Enabled agent, read tools only, public chat slug `policyreviewdemo1` |
| `policies/` | Authority the agent must cite |
| `documents/` | Samples to review |
