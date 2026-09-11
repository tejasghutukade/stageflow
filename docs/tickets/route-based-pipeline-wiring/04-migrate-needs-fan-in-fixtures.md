# 04: Migrate needs/fan-in fixtures and tests to route

**What to build:** The general DAG-resolution test file and its fixtures — linear chains, diamond fan-ins, cycle-detection cases, unknown-target rejection — are rewritten to use `route`/`entry` (from ticket 01) instead of `needs`. Multi-parent fan-in fixtures are rewritten to rely on ticket 01's implicit-AND join (every stage naming a target in its `route` must reach any terminal state before that target runs) rather than `needs`'s per-parent state gating; if a fixture depended on that per-parent gating specifically, it's rewritten to the closest equivalent shape achievable without it, noting the behavior gap inline. If a fixture combines `needs` with `fork` or `feedback_loop`, only its `needs` usage is migrated here — its fork/loop usage is migrated in tickets 05/06, so such a fixture may need touching again there. `needs` itself is not removed from the schema yet (that's ticket 07); this ticket only stops relying on it in this test file's fixtures.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Every fixture and test case in the general DAG-resolution test file that used `needs` for pure sequencing or fan-in now uses `route`/`entry` instead, and the suite is green.
- [ ] Diamond fan-in fixtures resolve correctly under ticket 01's implicit-AND join semantics.
- [ ] Any fixture that relied on `needs`'s per-parent state-gating (e.g. wait for A succeeded *and* B failed specifically) is called out explicitly in the ticket's implementation notes, with the closest achievable equivalent or an explanation of the dropped capability.
- [ ] Fixtures in this batch that also use `fork` or `feedback_loop` are left with those fields untouched (out of scope here) but flagged for follow-up in tickets 05/06.
- [ ] No fixture or test in this batch references `needs` by the end of this ticket.
- [ ] `fork` and `feedback_loop` support elsewhere in the codebase is untouched.
