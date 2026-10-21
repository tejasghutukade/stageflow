# 07: Host-computed login check

**What to build:** The Host opens the check address with the profile and matches the logged-in and logged-out patterns. A thin stage reports `{ logged_in, url }`. The Host validates the envelope against its own result. An agent fallback stage handles pages where patterns cannot decide.

**Blocked by:** 03, 06

**Status:** ready-for-agent

- [ ] The result is correct for a logged-in profile, a logged-out profile, and an unknown page.
- [ ] A stage that reports a different value than the Host result fails.
- [ ] The result routes the run with the existing route rules.
- [ ] The fallback agent stage works when the check cannot decide.
