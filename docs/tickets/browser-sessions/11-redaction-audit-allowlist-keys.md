# 11: Redaction, audit, allowlist, and encryption key

**What to build:** Redact cookie and storage values in logs. Store profile names only in run state and envelopes. Pass the domain allowlist to agent-browser. Add the key provider and the audit sink with local implementations.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A test shows no cookie value in logs, artifacts, envelopes, or run state.
- [ ] A navigation outside the allowed domains is blocked by the tool.
- [ ] The key provider supplies the key. The local key file has owner-only permissions.
- [ ] Profile created, used by run, and deleted each write an audit record.
- [ ] A Host-level site policy can block a site for all stages.
