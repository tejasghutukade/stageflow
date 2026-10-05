# 05: Console live view API

**What to build:** The console API for live view: request a ticket for a run, stage and mode (view or control), redeem it into a path-scoped cookie, open the event stream, and send ordered input. Control is issued only while the stage has a pending live view gate and is revoked when the gate is answered, abandoned or cancelled. Audit records for open and close; input never logged.

**Blocked by:** 02, 03

**Status:** done

- [x] A ticket is single use, lasts about a minute, and is bound to run, stage, mode and owner scope; reuse, expiry, wrong stage and wrong mode are refused.
- [x] `control` tickets are issued only for a stage with a pending gate that has a live view handoff; answering, abandoning or cancelling revokes them and ends the stream with a closed message.
- [x] The event stream replays the last frame first and carries frame, status, tabs, url, re-target and closed messages; console messages are not forwarded.
- [x] The input route requires the cookie and an anti-forgery header, rejects view sessions, validates and rate-limits batches, and never logs bodies.
- [x] Origin and Host checks reuse the existing allowed-host machinery; responses forbid framing and caching.
- [x] Audit records exist for live view opened and closed with ids and mode only.
- [x] Server route tests (with a fake relay and fake host injected) cover each rule; a regression test shows input bodies and frames never reach logs, run files, activity events or the audit sink.
