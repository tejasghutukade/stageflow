# 05: Full pipeline smoke test through containers, with a deliberate mid-run failure

**What to build:** A real multi-stage pipeline (e.g. `ship-feature`, or an equivalent plan → implement → review fan-out → ship shape) run start to finish entirely on container-based stage execution, with one attempt deliberately failed mid-run to prove retry and fan-out both hold up together in a real run — not just in isolation.

**Blocked by:** 02 (Retry resets correctly through a container), 03 (Concurrent fan-out attempts each get their own container), 04 (Commit-and-PR pattern works inside a container)

**Status:** blocked — needs a real model credential (ANTHROPIC_API_KEY or equivalent) not available in this environment; the underlying mechanics (01-04) are implemented and unit/integration-tested, this ticket is the live, credentialed run against a real multi-stage pipeline that's left for whoever has that credential.

- [ ] A real multi-stage pipeline runs start to finish entirely on container-based stage execution — no host-process (forked) stage execution occurs anywhere in the run, including retries and clones.
- [ ] One stage attempt is deliberately made to fail mid-run; the run retries it, resets via the existing checkpoint manifest, and continues successfully afterward.
- [ ] The pipeline's fan-out stage produces concurrent containers per clone and joins their results correctly.
- [ ] The final ship/PR stage commits and opens a PR only after operator approval.
- [ ] The run's `.stageflow/runs/<id>/` directory structure (attempts, artifacts, envelopes) is indistinguishable in shape from a pre-container run of the same pipeline.
