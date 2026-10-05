# 03: Live view relay core

**What to build:** A Host-side relay for one stage session using agent-browser's built-in stream: it finds the stream port, connects with Node's built-in WebSocket client, forwards frames and status messages to subscribers, replays the last frame to late joiners, accepts ordered validated input batches, and closes cleanly. It never sets the stream port through the environment and never runs agent-browser commands on a timer.

**Blocked by:** 01

**Status:** done

- [x] A subscriber that joins after the last frame still receives it immediately, even when the page is static.
- [x] Input batches are forwarded in order; malformed events, oversized batches and rate overruns are rejected without reaching the stream.
- [x] The relay reads the stream port through a single status query (or the session stream file) via the injected browser runner, and the stage env is not changed.
- [x] A relay with no subscribers can be closed idempotently; the stream client is torn down.
- [x] Input bodies and frame data are never logged.
- [x] A relay contract suite runs against a fake stream server (a local WebSocket server speaking the stream messages and recording input) and passes.
