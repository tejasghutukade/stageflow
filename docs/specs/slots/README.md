---
status: index
---

# Pre-container build slots

Nine self-contained implementation briefs. Each one is written to be handed to a single agent that
has seen none of the planning conversation — it orients the reader on Stageflow, states the mission,
lists verified current state with `file:line` citations, gives the work item by item with the design
decisions already made, and ends with acceptance criteria and open questions.

Plan they came from: [pre-container-work.md](../pre-container-work.md) ·
Visual walkthrough: [pre-container-work-explainer.html](../pre-container-work-explainer.html) ·
Evidence: [container-ready-assessment.md](../container-ready-assessment.md)

## The slots

| # | Brief | Ships | Depends on |
|---|---|---|---|
| 1 | [Durable root and schema version](slot-1-durable-root-and-schema-version.md) | `STAGEFLOW_HOME`, one documented layout, `PRAGMA user_version` + migrations, downgrade refusal | — |
| 2 | [Repository binding and worktrees](slot-2-repository-binding-and-worktrees.md) | A Run names a repository and gets its own `git worktree`; git identity; the three checkout-visibility tools | 1 |
| 3 | [Run lifecycle and GC](slot-3-run-lifecycle-and-gc.md) | `cancel_run`, `delete_run`, two-stage retention, the admission queue, disk admission | 1, **2**, 4 |
| 4 | [Daemon behaviour](slot-4-daemon-behaviour.md) | Graceful shutdown, the non-terminal `interrupted` status, no rival autostart, JSON logs, process groups | 1 |
| 5 | [Access control](slot-5-access-control.md) | Bind resolution, no-browser, allowed hosts, control token, refuse-to-start | 1 |
| 6 | [Stage environment and secrets](slot-6-stage-environment-and-secrets.md) | The curated child env, declared `secrets:`, proxy, CA trust, caches, heap ceiling | 1, 2, 5 |
| 7 | [Multi-project, health and catalog](slot-7-multi-project-health-and-catalog.md) | One catalog path, the enforced path contract, three health surfaces, `sf doctor`, the seeded example catalog | 1, 5 |
| 8 | [Data safety and release](slot-8-data-safety-and-release.md) | Backup and restore, SQLite durability decisions, provenance, the egress threat model, whole-instance export | 1, 3, 6 |
| 9 | [Harness parity and polish](slot-9-harness-parity-and-polish.md) | `start_run` parity, rerunnable inline pipelines, run-scoped skills, preflight, the run manifest, caller attribution | 1–8 |

## Rules that constrain the schedule

These are not preferences. Each is a specific failure.

1. **Slots 2 and 3 ship in the same release.** Worktree creation without worktree cleanup is a disk
   leak. On a laptop you `rm -rf` by hand; in a container there is no hand.
2. **Slot 1's schema versioning lands before the first published image.** The moment there is an
   image tag someone rolls it back, and today an older binary opens a newer store happily and writes
   rows the newer code will misread.
3. **Slot 5's allowed-hosts change and its control token are one commit.** The loopback gate is
   currently the only authentication `/mcp` has, so relaxing it alone publishes an unauthenticated
   endpoint that runs arbitrary `bash`.
4. **Slot 3's `queued` and `cancelled` statuses go in one schema pass.** Each ripples through the
   store, the types, MCP and REST responses, the console, and the CI exit codes.

## Cross-slot coupling worth knowing before you dispatch

- Slot 3's `cancel_run` does not actually work until slot 4 fixes the process-group kill. The
  existing `SIGKILL` escalation is unreachable because it guards on `child.killed`, which is true as
  soon as a signal is *sent*. Land slot 4's fix first, or have the two agents coordinate.
- Slot 2 introduces a `GITHUB_TOKEN` for Host-side fetching that every stage's `bash` can read until
  slot 6 lands. That is a changelog caveat slot 2 must carry.
- Slot 7 must repoint the autostart health probe when it gates `/api/health`, or `sf run` breaks on
  every machine. Slot 5 deliberately left that route open for this reason.
- Slot 9's persist-inline-pipelines change is what makes a run record self-contained enough for slot
  8's whole-instance export. Design them together even if they ship apart.

## Running them in parallel

Slots 4, 5 and 7 are independent of the slot 2 line and can run alongside it. Slot 1 blocks
everything. A reasonable three-track split:

- **Track A (longest):** 1 → 2 → 3 → 9
- **Track B:** 4 → 6
- **Track C:** 5 → 7 → 8

## What is deliberately not here

The Dockerfile, the compose file, and registry publishing. They come after all nine slots, and a
Dockerfile written before slot 1 lands has to be rewritten. At that point it is roughly nine lines.
