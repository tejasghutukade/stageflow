# feedback-loop

Source-owned feedback loop: `review` may `continue` or `send_back` to `implement`.
`submit` is `replay_safe: false` so it is never on a replay route.

Domain-neutral — the same wiring works for release notes, research digests, content review, or an SDLC-style plan/implement pass.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`), **or** this repo built (`npm run build`)
- Provider auth connected (`sf ui` → Settings → Providers, or `sf providers login …`)

## Manual verification (recommended)

Step-by-step scenarios A–D (continue, one send_back, require_continue exhaust, wait_for_human decide):

→ **[VERIFY.md](./VERIFY.md)**

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml --strict
sf run \
  --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml \
  --task examples/feedback-loop/feedback-loop.task.yaml
```

Wait-for-human policy (`max_replays: 1`):

```bash
sf run \
  --pipeline examples/feedback-loop/feedback-loop-wait-human.pipeline.yaml \
  --task examples/feedback-loop/exhaust-wait-human.task.yaml
```

Optional console (any subdirectory):

```bash
cd examples/feedback-loop && sf ui
```

### From the Stageflow repo (no global install)

```bash
npm run build
npm run dev -- validate --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml --strict
npm run dev -- run \
  --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml \
  --task examples/feedback-loop/feedback-loop.task.yaml
```

## Layout

```
examples/feedback-loop/
  VERIFY.md                          # manual scenarios A–D
  feedback-loop.pipeline.yaml        # require_continue, max_replays 2
  feedback-loop-wait-human.pipeline.yaml
  feedback-loop.task.yaml
  continue-only / send-back-once / exhaust-*.task.yaml
  plan.yaml | implement.yaml | review.yaml | submit.yaml
```

## References

- [YAML catalog — Feedback loops](../../docs/yaml-catalog.md#feedback-loops)
- [Envelopes — Feedback loops](../../docs/envelopes.md#feedback-loops)
- [CLI — feedback-decide](../../docs/cli-reference.md#sf-runs-feedback-decide)
