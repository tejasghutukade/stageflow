# 02: Branch selection via route_select and allow_none

**What to build:** A stage with more than one forward `route` entry can be a fork: `route_select: "one" | "subset"` plus `allow_none: boolean`, declared as siblings of `route`, control how many of the stage's envelope-reported (`fork_choice`) selections are allowed to fire, exactly matching today's `fork` config's behavior. Unchosen entries' targets (and their descendants) are skipped via the same cascade as today. `route_select` on a stage with fewer than two forward route entries is a validation error, mirroring today's rejection of `fork` on a leaf. This ticket builds on ticket 01's forward-routing resolution; it does not touch `needs`, `fork`, or `feedback_loop`, which keep working unchanged. Proven with new fixtures only.

**Blocked by:** 01 (needs forward-routing resolution to attach selection to)

**Status:** ready-for-agent

- [ ] A stage with `route_select: "one"` and ≥2 forward route entries resolves such that exactly one envelope-chosen entry's target runs; the rest (and their descendants) are skipped.
- [ ] A stage with `route_select: "subset"` allows any number of envelope-chosen entries to fire simultaneously.
- [ ] `allow_none: false` (default) requires the envelope to choose at least one entry; `allow_none: true` permits zero.
- [ ] `route_select` present on a stage with fewer than two forward route entries fails validation with a clear error.
- [ ] Skip-cascade for unchosen branches' descendants matches today's `fork` behavior exactly.
- [ ] `needs`, `fork`, and `feedback_loop` continue to parse and resolve exactly as before; no existing test or fixture using them is touched or broken.
- [ ] New fixtures and resolver tests cover: `route_select: "one"`, `route_select: "subset"`, `allow_none: true` and `false`, and the leaf-rejection case.
