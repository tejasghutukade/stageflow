# 16: Provider-neutral proof

**What to build:** Prove the abstraction: a stand-in orchestrator adapter (recorded-API or stub) passes the same conformance suite, the `provider_view` path returns a short-lived viewer address through the live view route with a fake provider viewer, and a structural test shows no provider name or provider SDK import appears outside adapter modules.

**Blocked by:** 15, 05

**Status:** ready-for-agent

- [ ] The stand-in adapter passes the orchestrator and browser host conformance suites without changes to core modules.
- [ ] With a fake provider viewer, the live view route returns a short-lived address that is never stored in a gate, run file, log or audit record.
- [ ] A capability mismatch (human login on a view-only provider) fails at stage start naming the missing capability.
- [ ] A structural test fails if a provider name or SDK import appears in core modules.
- [ ] Provider credentials never appear in stage environments, run files, envelopes or logs (tested).
