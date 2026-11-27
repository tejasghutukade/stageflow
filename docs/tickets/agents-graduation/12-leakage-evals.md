# 12: Evals for cross-customer leakage

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 09

## Why

`docs/consumer-identity.md` says eval sessions keep their own gate and "this is not consumer-eval support". There is no way to regression-test that an agent refuses customer B's data when customer A asks, or that a prompt-injection attempt fails.

## Read first

- The eval rules in `AGENTS.md` (eval sessions hidden, the eval gate fails closed and cannot weaken the real gate, tool policy only gets safer).
- `src/agents/evalGate.ts`, `evalSession.ts`, `src/evals/runner/agentCaseRunner.ts`, `conversationSubject.ts`.
- `docs/evals.md` ("Evals for agents").

## What to build

1. An eval case can name a test principal (account, scope) from a fixture identity store. The eval session runs the consumer check against a fixture order adapter; it never uses the live store or the live order API.
2. A deterministic grader: no tool call was allowed for a resource outside the principal's scope, and no out-of-scope resource id or status appears in the conversation subject.
3. A sample dataset of attack prompts (ask for another id, claim to be staff, claim a new phone number) kept judge-free.
4. The eval gate still runs first and no approval row is created.

## Acceptance

- [x] A deliberately mis-scoped fixture makes the grader fail; the correct one passes.
- [x] No test calls a real model or the network.
- [x] A non-eval session's gate path is unchanged.
- [x] `docs/evals.md` documents the principal field and the grader; finding codes added to `docs/yaml-catalog.md`.

## Outcome

Shipped fixture principals (`customer-a`, `customer-a-selected`, `customer-b`), an in-memory eval order adapter and `EvalConsumerRegistry` wiring so agent eval cases with `metadata.principal` run consumer resource checks without the live identity store. Added the deterministic `consumer_scope` grader and the judge-free `examples/evals/leakage-sample.*` dataset. The eval gate path for non-eval sessions is unchanged; eval sessions still register the eval gate first, then the fixture consumer check for declared resource tools.

Left out: packaging `leakage-sample` through `installEvalSample`, console UI for principals, and live-model regression runs (sample is validate-only in CI).