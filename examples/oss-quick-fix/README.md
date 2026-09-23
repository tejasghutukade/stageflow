# oss-quick-fix

A minimal, fully unattended sibling of
[`oss-issue-contribution`](../oss-issue-contribution/): one straight-line
spine from "understand the issue" to "PR opened against my fork," with no
operator gate anywhere in the run.

Every stage declares `gate_kinds: []`, which unregisters `ask_operator`
entirely — stages must decide and proceed, never pause for a human. Use this
shape for issues small enough that you trust a single unsupervised pass; use
`oss-issue-contribution` when you want parallel investigation/review and an
operator approval before anything ships.

## Flow

```
understand-issue → implement-fix → verify-fix → ship-fix
```

1. **understand-issue** — Reads the task goal/context, locates the responsible
   code, reproduces the bug if practical, and writes `investigation.md`.
2. **implement-fix** — Writes a failing regression test, fixes the root cause,
   confirms the test (and the broader suite) passes, and writes
   `fix-report.md`. `changed_files` must match `git diff --name-only` exactly.
3. **verify-fix** — Independently re-runs the repo's real check/lint/test
   commands against the actual diff (not the report's description of it) and
   writes `verification.md`. `all_passed` is true only if every command it
   ran actually exited zero.
4. **ship-fix** — Commits, pushes, and opens a pull request against
   `publish_repo` — the fork named in the task, never the upstream repo — and
   writes `ship-report.md`. Refuses to proceed if `verify-fix` did not pass or
   if the task does not name a fork.

Every stage declares `on_verify_fail: { mode: repair, retry_safety: idempotent, max_attempts: 3 }`
except `ship-fix`, which uses `mode: manual` / `retry_safety: side_effecting`
because it is the only stage with side effects (git push, PR creation).

## Runtime contracts

| Stage | Required artifact | Other checks |
|-------|--------------------|---------------|
| `understand-issue` | `investigation.md` | — |
| `implement-fix` | `fix-report.md` | `type: checkout_changes` on `changed_files` |
| `verify-fix` | `verification.md` | — |
| `ship-fix` | `ship-report.md` | — |

## Run

Fill in [`oss-quick-fix.task.yaml`](oss-quick-fix.task.yaml) — the issue, the
fork to publish to, and `checkout` pointed at a clean working tree of the
target repository.

```bash
sf validate --pipeline examples/oss-quick-fix/oss-quick-fix.pipeline.yaml --strict
sf run \
  --pipeline examples/oss-quick-fix/oss-quick-fix.pipeline.yaml \
  --task examples/oss-quick-fix/oss-quick-fix.task.yaml
```

Needs a configured provider (`sf providers status`), and `gh` on `PATH`
authenticated (`GH_TOKEN` or `GITHUB_TOKEN`) before `ship-fix` runs, or the
publish step fails after the fix is already verified.

Run `sf ui` in another terminal to inspect envelopes and artifacts — there are
no gates to answer.
