# 14: Sandbox orchestrator and conformance suite

**What to build:** The provider-neutral sandbox orchestrator port (start, graceful stop, list by label, inspect, idempotent release), a development implementation using the local container CLI (development only), and a conformance suite every orchestrator must pass. The port leaves a place for an egress policy.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The port and its types are provider-neutral; adapter-specific data lives in one opaque versioned field.
- [ ] The development implementation starts, labels, lists and removes containers for a fake image; release is idempotent.
- [ ] The conformance suite runs against the in-memory fake and the development implementation (the latter opt-in).
- [ ] The port has a documented, unused place for an egress policy.
- [ ] No container runtime socket is required inside a Stageflow container.
