# 04: Commit-and-PR pattern works inside a container

**What to build:** No new stage type or schema change — Stageflow already supports an explicit, operator-gated commit via prompt-authored stages (see `examples/ship-feature/feat-ship.yaml`: an `ask_operator` / `artifact_backed` gate, then the agent itself runs `git commit`, `git push`, and `gh pr create`). This ticket verifies that pattern keeps working unchanged when the stage runs inside the new container execution path — git and gh available in the image, tokens forwarded, GitHub network access working.

**Blocked by:** 01 (Run a single stage attempt inside a container)

**Status:** partially verified — mechanics confirmed safely, live PR creation deliberately not attempted

- [x] The generic image includes working `git` and `gh` binaries (`git version 2.39.5`, `gh version 2.100.0`, confirmed by running `--version` inside a real container) and correctly receives forwarded credentials — verified `GH_TOKEN` set on the host reaches `process.env.GH_TOKEN` unchanged inside the container via the launcher's bare `-e GH_TOKEN` forwarding.
- [x] `git commit` works correctly inside a container against a mounted path: initialized a scratch git repo in a temp dir, mounted it into a container, ran `git init`/`config`/`add`/`commit` inside, and confirmed the resulting commit is visible from the host afterward via `git log` — proving the commit mechanic (agent commits inside a container, change persists to the host through the mount) works end to end.
- [ ] Running `ship-feature`'s `feat-ship` stage for real, reaching the `ask_operator` gate and then actually committing/pushing/opening a PR, requires a real model credential (none available here) to drive the agent, and opening a real PR requires the user's explicit go-ahead per this session's operating rules (creating a PR is a permission-gated action) plus a disposable token/repo. Deliberately not attempted autonomously — the safe, non-destructive parts above (git/gh functional, credentials forwarded, commits persist through the mount) are what this session could verify without those.
