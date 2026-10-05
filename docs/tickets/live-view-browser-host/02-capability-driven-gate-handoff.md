# 02: Capability-driven gate handoff

**What to build:** The Host stamps the gate handoff from the host's capabilities: `local_window` when a person can see a window, `live_view` (a stable root-relative path identifying the run and stage) when the display is virtual or headless with a relay. The handoff parser (server and UI type guard) accepts root-relative paths and rejects double-slash and non-http schemes. The human-login precondition becomes a capability decision with rewritten messages, and the login prompt text changes for `live_view`.

**Blocked by:** 01

**Status:** done

- [x] With a fake host reporting a virtual display, a human login gate carries a `live_view` handoff whose address is a stable path and contains no token.
- [x] With a desktop host the gate still carries `local_window` (no change).
- [x] A handoff supplied by the agent is overwritten, and stripped for stages without a browser (existing guarantee still holds).
- [x] The human-login precondition throws before the agent starts only for the capability combinations in spec D2, with clear messages for headless-only hosts and for a missing relay.
- [x] The human login prompt block says the operator logs in through the live view when the handoff is `live_view`.
- [x] Gate handoff and human-login runtime tests cover each case; the UI type guard accepts and rejects the same inputs as the server parser.
