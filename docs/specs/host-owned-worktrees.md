# Host-owned worktrees (locked)

Index: [container-ready](container-ready.md)

Isolation for a Repository-bound Run follows Intentic’s worktree pattern, not its land-to-main editor model.

## Locked

1. **One working tree per Run.** The Host keeps a shared git object store (bare clone cache) per GitHub Repository. Each Run gets its own `git worktree` on that store. Two Runs never share a dirty checkout.
2. **That worktree is the Checkout.** Agent `cwd` is the worktree. Stages edit, commit, and (if the pipeline says so) push/`gh pr create` there.
3. **Worktrees live with Host state, not in the Catalog.** Optional `/workspace` is Catalog (and path-`checkout` trees only). Run store, bare clones, and worktrees are under Host home (`STAGEFLOW_HOME` / `~/.stageflow`), so agent `bash` in a Checkout cannot treat the SQLite store as project files.
4. **Stable path without mount namespaces.** Export `STAGEFLOW_CHECKOUT` (and keep `STAGEFLOW_RUN_WORKSPACE`). Do not take `SYS_ADMIN` to remount the worktree over `/workspace`. A stable symlink is allowed later; env is the v1 contract. Stage prompts and `verify` commands must not hardcode `~/.stageflow/worktrees/<runId>`.
5. **No Host “land”.** There is no apply-delta-as-uncommitted-on-a-shared-`/work` API. The Run’s branch in its worktree is the git record. Opening a PR is a pipeline stage, not a Host feature.
6. **XOR with path checkout.** A Run is Repository+required ref **or** path `checkout` **or** unbound. Both Repository and `checkout` is an error. Path `checkout` is the bind-mount / laptop case (Intentic’s shared-tree chat analogue).
7. **The Host links the repo.** `start_run` with `task.repository` + `task.ref` is a Host git operation: fetch (or first clone) the bare cache, then `git worktree add` for this Run. Stages start with a Checkout already on disk. A stage `git clone` is not how a Repository enters the container.
8. **Clone credentials stay on the Host.** HTTPS fetch uses `GITHUB_TOKEN` / `GH_TOKEN` already in the container environment. The harness does not send a token on `start_run`.
9. **The Repository is frozen at start.** One GitHub repo + one required ref per Run. The Host does not clone extra remotes into that Run after `start_run` succeeds.
10. **A failed link fails the start.** If clone, fetch, or worktree fails, `start_run` returns an error and no Run is created (or it is not started). On success the Run record stores `checkout_root` plus the Repository identity and ref that produced it.

## Not locked (still later)

GC/TTL for finished worktrees, credential helper vs raw `GITHUB_TOKEN` in stage env, GitHub-only vs any git URL.

## Rejected

- Full `git clone` per Run
- One shared working copy for all Runs of a repo
- Linux mount-namespace `/work` overlay
- Intentic Landing (uncommitted onto an operator main tree)
- First-stage `git clone` as the way a Repository is linked
- Token on `start_run`
- Bind-mount of a laptop clone as the default GitHub path (that is path `checkout`, XOR)
