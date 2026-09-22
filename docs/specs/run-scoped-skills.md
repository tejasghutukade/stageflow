# Run-scoped skills (locked)

Index: [container-ready](container-ready.md)

Harness create remains inline `start_run` only (no Catalog `put_pipeline`). Skills travel with that call, not as a durable Host skill drawer.

Stage `skill: <name>` is the link. The Host materializes files for this Run, then Pi resolves the name. This is Intentic’s “write the pack, bind by name,” scoped to a Run because there is no Catalog put yet.

## Locked

1. **`start_run.skills`** is a map of name → files. At least `SKILL.md` per name. Extra relative paths allowed (scripts the skill needs). Absolute paths and `..` are rejected.
2. **Harness sends bytes**, not a URL. No fetch/clone of a skill repo on `start_run`. `sf skills install --from-path|--from-zip` stays the operator/image/`/workspace` path.
3. **Host writes beside the Run**, under the run workspace (e.g. `runs/<runId>/skills/<name>/`). Not into the Checkout / Worktree (would dirty the GitHub PR). Not into a global Host skill catalog.
4. **Link is `skill:` on the stage.** Every name used in the inline pipeline must exist in `start_run.skills` or already on disk. Missing → fail before the agent starts (same as today).
5. **One map, shared.** Two stages with `skill: archify` share one materialized copy.
6. **Precedence:** run payload > Checkout `.pi/skills` > Host/image operator skills. Same name: run wins. Record which origin was used.
7. **Lifetime = the Run.** Delete/gc of the Run deletes those files. Reuse = send the same map again.
8. **No generated GitHub skill** from `GITHUB_TOKEN`. If a stage needs `gh` instructions, the harness includes that `SKILL.md`.

## Not locked (still later)

Durable `put_skill` / Host skill drawer, `list_skills` origin field on MCP, auto-stamped builtin skills.

## Rejected

- Download/clone a skill URL as part of `start_run`
- Writing skills into the Worktree
- Intentic-style long-lived `POST /skills` in v1 (Catalog put deferred)
- Extension/marketplace sha installs as the v1 skill path
