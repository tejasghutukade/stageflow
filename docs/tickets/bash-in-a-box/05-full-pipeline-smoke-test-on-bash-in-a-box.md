# 05: Full pipeline smoke test on Bash-in-a-Box

**What to build:** A real multi-stage pipeline (e.g. `ship-feature`, or an equivalent plan → implement → review fan-out → ship shape) run start to finish on Bash-in-a-Box, with one attempt deliberately failed mid-run — proving retry, fan-out, and the architectural fix for v1's lost-failure-reason problem all hold up together in a real run.

**Blocked by:** 04 (Remove v1's whole-worker container mode)

**Status:** ready-for-agent

- [ ] A real multi-stage pipeline runs start to finish with every `Bash` call sandboxed via `sandbox_bash`/`toolAliases` — no container runs the worker process itself anywhere in the run.
- [ ] `ANTHROPIC_API_KEY` is confirmed to never appear in any container's environment or args at any point in the run (only the host process holds it).
- [ ] One stage attempt is deliberately failed mid-run; the retry surfaces the real failure reason via normal `process.send`/exit-code signaling — not the stderr-tail fallback v1 needed — proving the IPC-loss problem is architecturally gone.
- [ ] The pipeline's fan-out stage produces concurrent per-clone containers and joins results correctly, with no fan-out-specific code added (inherited for free per ticket 02).
- [ ] The final ship/PR stage's `ask_operator`/`artifact_backed` gate and subsequent `git commit`/`gh pr create` still work, running as agent-issued `Bash` calls inside the sandbox container.
- [ ] The run's `.stageflow/runs/<id>/` directory structure is indistinguishable in shape from a pre-Bash-in-a-Box run of the same pipeline.
