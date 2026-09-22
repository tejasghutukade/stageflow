---
status: index
---

# Container-ready

Stageflow Host in Docker, consumed by an external Harness over MCP (and A2A for published pipelines). Create stays **inline `start_run`**. Implementation is not started — read this index, then open the child that matches the work.

Language: Host, Run, Catalog, Checkout, Repository, Worktree, Skill, Harness, Operator — [CONTEXT.md](../../CONTEXT.md)

## Locked

| Open | When |
|------|------|
| [Host-owned worktrees](host-owned-worktrees.md) | Repository-bound Run, Checkout vs Worktree, Host clone + `git worktree` on `start_run`, XOR with path checkout |
| [Run-scoped skills](run-scoped-skills.md) | `start_run.skills` bytes, materialize beside the Run, `skill:` link, no Catalog put |

ADRs (local, gitignored): [0001 Host](../adr/0001-container-ready-host.md) · [0002 worktrees](../adr/0002-host-owned-worktrees.md) · [0003 skills](../adr/0003-run-scoped-skills.md)

## Read first

| Open | When |
|------|------|
| [Build slots](slots/README.md) | **Nine agent-ready implementation briefs**, one per build slot. Hand one to an agent and it can start without asking |
| [Pre-container work](pre-container-work.md) | **The work list.** Thirteen workstreams in nine build slots, led by repository binding + worktree-per-Run. Start at *Build order* |
| [Pre-container work — explainer](pre-container-work-explainer.html) | The same plan as a visual walkthrough, slot by slot, with diagrams and examples |
| [Independent assessment](container-ready-assessment.md) | Verified current state, gap register (P0/P1/P2), two-tier bar, acceptance test, recommended phase order |
| [Container-readiness — explainer](container-ready-explainer.html) | Visual walkthrough of *why* the blockers are blockers: bind, Host header, RCE chain, shutdown, disk leak |
| [Spec review](container-ready-spec-review.md) | Where the analysis below is wrong (bind work does not exist; store already moved), what it misses, what to keep |

## Background (not locked)

| Open | When |
|------|------|
| [Analysis vs Intentic](container-ready-analysis.md) | Gaps: store off Checkout, control token, Host/Origin, image/PID 1 hygiene, suggested phases. **§3 "as it exists" is unreliable — see the [spec review](container-ready-spec-review.md)** |
| [Plan dispatch (HTML)](../container-ready-plan.html) | Keep / Change / Add board against the Docker plan |
| [Intentic lessons (HTML)](intentic-plan-improvements.html) | Same workstream, Intentic-shaped presentation |

## Deferred

Durable Catalog put (`put_pipeline` / `put_skill` / Host skill drawer). Inline `start_run` is the v1 create path.
