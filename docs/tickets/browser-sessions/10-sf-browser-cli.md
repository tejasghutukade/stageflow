# 10: `sf browser` commands

**What to build:** Commands to list profiles, show status, check a profile, log in to a profile in a visible window, and clear a profile.

**Blocked by:** 01, 07

**Status:** ready-for-agent

- [ ] List shows names and last use, never paths or cookie values.
- [ ] Check prints the Host-computed result and uses exit codes and JSON output as the CLI contract requires.
- [ ] Login opens a visible window and ends when the check passes or the operator stops it.
- [ ] Clear asks for confirmation unless a flag is given.
