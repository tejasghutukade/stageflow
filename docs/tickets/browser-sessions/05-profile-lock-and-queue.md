# 05: Profile lock and queue

**What to build:** A profile lock interface with a local lock-file implementation. Two stages or two runs that need one profile do not run together. The second waits in a queue and shows a waiting state that names the holder.

**Blocked by:** 01, 03

**Status:** ready-for-agent

- [ ] The scheduler does not start a stage while another stage holds its profile.
- [ ] A second run waits and shows "waiting for browser profile" with the holder run id.
- [ ] The lock is released on success, failure, cancel, and Host restart.
- [ ] The lock stays held while a stage waits for the operator.
- [ ] The lock contract suite runs against the local lock and an in-memory fake.
