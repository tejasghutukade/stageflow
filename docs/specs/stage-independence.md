# Stage independence

Status: draft, synthesized from the design discussion. Not published to an issue tracker.

## Problem Statement

A stage often stops when a terminal Pi session, given the same job, would try another approach. The stage is told that a finished turn without an envelope is close to failure, a failure envelope is easier to get accepted than a success envelope, and after a short run of quiet turns the attempt ends. Compaction then records that dead end so it is not retried.

That finish line was built so a pipeline would hand off a typed envelope and would not run forever. In practice it has become a reason to give up. Stages also do work that is not "edit this repository": research, review, ops, a message to a customer. They need room to change approach inside the job they were given, without inheriting a codebase's own agent instructions.

A stage that does work inside a sandbox is missing the search tools a model reaches for first. `grep`, `find`, and `ls` on the host would see the wrong tree. Without confined versions, the sandbox is a smaller tool set than the stage needs, and a missing tool is another way the stage stops early.

## Solution

A pipeline author sets an independence level on a stage. Omitted, the stage is persistent: it keeps working instead of being steered into failure. `strict` is the opt-in for today's short reminder budget. `open` is persistent plus permission to change approach. None of the levels load a repository's `AGENTS.md`, turn on extra job tools, or weaken a success envelope.

When a stage's job is the checkout, the author opts in separately. That stage then receives that checkout's `AGENTS.md` as extra context. The stage assignment stays in charge.

Every stage, at every level, can search and list. Inside a sandbox those tools run in the container and can only see the sandbox workspace, plus a read-only folder when one is mounted. Outside a sandbox they see the stage's own working tree.

## User Stories

1. As a pipeline author, I want a stage that omits the independence level to behave as persistent, so that the usual stage keeps working instead of giving up.
2. As a pipeline author, I want to set a stage to persistent, so that it keeps working after a turn that did not emit instead of being steered into failure.
3. As a pipeline author, I want to set a stage to open, so that a failed approach is treated as one dead end and the stage tries another approach with the tools and inputs it already has.
4. As a pipeline author, I want to set independence once on the pipeline, so that every stage that does not set its own level inherits it.
5. As a pipeline author, I want to set independence once on the manifest, so that pipelines that omit it share one default.
6. As a pipeline author, I want a stage's own level to win over the pipeline and the manifest, so that one careful stage can stay strict inside a freer pipeline.
7. As a pipeline author, I want an unknown level to fail catalog load, so that a typo does not silently run as persistent.
8. As a pipeline author, I want the author's stage prompt left as I wrote it, so that a stage I told to fail closed still fails closed.
9. As a pipeline author, I want a success envelope to keep matching the stage's output schema, so that the next stage still receives a typed handoff.
10. As a pipeline author, I want a listed artifact to still have to exist on disk before success is accepted, so that the handoff cannot name a file that was never written.
11. As a pipeline author, I want a failure envelope to remain a real ending, so that a stage that is truly blocked can still stop the pipeline on purpose.
12. As a pipeline author, I want persistent and open reminders to ask the stage to keep working, so that the host is not the voice telling it to emit failure.
13. As a pipeline author, I want those reminders to stop counting down from a tiny budget, so that the stage does not treat "2 of 2" as permission to quit.
14. As a pipeline author, I want the attempt to still end after a hard ceiling of unanswered reminders, so that a stage cannot loop forever.
15. As a pipeline author, I want a provider error, a timeout, a cancel, or a closing stage to stop reminders immediately, so that independence does not retry a dead session.
16. As a pipeline author, I want compaction to stay on at every level, so that a long stage still fits its context window.
17. As a pipeline author, I want persistent and open compaction to record a failed approach and the next one still available, so that a later turn does not treat the dead end as final.
18. As a pipeline author, I want a summary written at one level not to be reused at another, so that a strict "do not retry" summary cannot steer an open stage.
19. As a pipeline author, I want both agent backends to apply the same persistent and open policy, so that the level means the same thing on Pi and on Claude.
20. As a pipeline author, I want strict to preserve each backend's current reminder behavior, so that the short budget is something I opt into.
21. As a pipeline author, I want open to tell the stage not to invent a stand-in for an input it could not read, so that freedom of method does not become fabricated inputs.
22. As a pipeline author, I want open to leave declared tools alone, so that a message stage does not gain a browser and a research stage does not gain a channel.
23. As a pipeline author, I want `ask_operator` to stay tied to the stage's gates, so that independence does not start asking a person.
24. As a pipeline author, I want channel recipients and the rule against resending an unknown send to stay as they are, so that a freer stage cannot widen who it writes to.
25. As a pipeline author, I want stage secrets and the stage environment allowlist to stay as they are, so that independence is not a way to inherit the host's tokens.
26. As a pipeline author whose stage is not about a repository, I want open to leave every `AGENTS.md` unloaded, so that the stage does not pick up Stageflow's knowledge or the checkout's coding-agent instructions.
27. As a pipeline author whose stage's job is the checkout, I want to opt in to that checkout's `AGENTS.md`, so that the stage can follow the repository it is actually editing.
28. As a pipeline author, I want that opt-in to be separate from the independence level, so that a strict stage can still read the checkout file and an open stage that is not working in a repo does not.
29. As a pipeline author, I want checkout context to be set on the stage body only, so that a pipeline of mixed jobs does not load a repository file into a stage that sends a message.
30. As a pipeline author, I want checkout context on a stage that has no checkout to fail catalog load, so that the flag cannot mean "load whatever file is nearby."
31. As a pipeline author, I want a missing `AGENTS.md` in the checkout not to fail the stage, so that a repository without that file still runs.
32. As a pipeline author, I want the walk for that file to stop at the checkout root, so that a parent folder outside the checkout is never read.
33. As a pipeline author, I want the stage assignment to win when it conflicts with `AGENTS.md`, so that the file cannot replace the envelope contract or the stage's job.
34. As a pipeline author, I want skills, extensions, and other agent-instruction files to stay sealed even when checkout context is on, so that opting into one file does not open the whole agent directory.
35. As an operator, I want a stage that stops with no envelope after the strict budget to still fail as a missing emit, so that I can tell a give-up from a real failure envelope.
36. As an operator, I want a persistent stage that keeps calling tools to be allowed up to the same hard ceiling as today, so that progress resets the quiet count and a runaway still stops.
37. As an operator, I want a leaked tool call written out as text to still fail with the provider error that says so, so that independence does not hide a provider parsing failure.
38. As an operator, I want verify after a success emit to work as it does today, so that independence does not skip host proof.
39. As an operator running a sandboxed stage, I want `grep`, `find`, and `ls` to search the sandbox workspace, so that the stage can look through the materials it was given.
40. As an operator running a sandboxed stage, I want a host path passed to those tools to be rejected, so that search cannot see the machine outside the sandbox.
41. As an operator running a sandboxed stage, I want a path that escapes the workspace with `..` to be rejected, so that confinement is the same rule the sandbox read tool already uses.
42. As an operator, I want a read-only folder mounted into the sandbox to be searchable, so that files the stage was given outside the workspace root are not invisible to search.
43. As an operator, I want prior artifacts granted under the workspace to be searchable with the rest of the workspace, so that grants do not need a special search tool.
44. As an operator running a stage without a sandbox, I want the same three tools to search the stage's working tree, so that turning the sandbox on does not add or remove a capability.
45. As an operator, I want a huge search result to be capped like a huge read or bash result, so that one listing cannot fill the stage's context window.
46. As an operator, I want both agent backends to expose those search tools, so that a Claude stage in a sandbox is not missing what a Pi stage has.
47. As a pipeline author, I want the independence level and the checkout-context flag to be part of what an eval snapshot records, so that two eval runs at different levels do not share a fingerprint.
48. As a pipeline author, I want the catalog reference to document the level, the checkout-context flag, and the sandbox search boundary, so that I can set them without reading the runtime.

## Implementation Decisions

- Independence is a stage body field with three values: `strict`, `persistent`, and `open`. Omitted means `persistent`.
- Effective independence is materialized at pipeline load, in the same tier order as the stage model: the stage body, then the root pipeline, then the manifest. A fragment's copy of the field is ignored. An unknown value fails catalog load. Absence of a manifest means there is no global default, and the result is `persistent`. A present but invalid manifest still fails load.
- Checkout context is a separate boolean on the stage body only. Omitted means off. It is rejected at catalog load when the stage is not bound to a checkout. It is not inherited from the pipeline or the manifest.
- One policy object is resolved for the attempt and consumed by both agent backends. Persistent and open must not be implemented twice with different budgets or different reminder text.
- `strict` leaves each backend's current reminder behavior in place. On Pi that is two quiet reminders, a reset when a reminder turn uses a tool, and a hard ceiling of twenty. On Claude that is two reminders with no progress reset. The reminder may still offer a failure envelope, as it does today.
- `persistent` and `open` share one reminder policy on both backends. A quiet turn is a continuation, not "reminder N of 2". The no-progress budget is the hard ceiling of twenty. A reminder turn that uses a tool still resets the quiet count. The hard ceiling still ends the attempt. The reminder tells the stage to keep working. It does not tell the stage to emit failure. A failure envelope remains valid if the stage chooses it.
- `open` adds one instruction on top of `persistent`: a rejected emit, a failed command, or a missing file ends that approach; try another approach with the tools and inputs already given; emit failure only when the stage can name a blocker none of those can get past; do not create a stand-in for an input that could not be read. At `strict` and `persistent`, the current sandbox line that says to stop when a given file is missing stays as it is.
- The author's stage prompt is not rewritten at any level. Host text that changes is the reminder, the compaction focus, and, at `open`, the guidance about a missing file.
- Compaction stays enabled at every level. `strict` keeps the current focus, including the line that records a dead end so it is not retried. `persistent` and `open` use a focus that records the failed approach, why it failed, and the next approach still available. The compaction prompt version includes the level, so a summary produced at one level is not reused at another.
- A provider error, an aborted turn, a timeout, and a stage that is closing or parked on a gate still skip reminders at every level. A tool call written out as plain text still ends as the existing provider error once the reminder budget is spent.
- Success still requires a payload that matches the stage output schema, emit-time checks, and real files for listed artifacts. A failure envelope still skips those checks and ends the attempt. After-phase verify is unchanged. Automatic repair still follows a failed verification, not a missing emit and not a failure envelope.
- The level does not register a skill, a Project MCP server, a browser, a channel, a memory tool, or `ask_operator`. Those stay declarations on the stage. Search tools are the exception below, and they are not gated on the level.
- Checkout context loads only `AGENTS.md` from the checkout, walking no higher than the checkout root. A missing file starts the stage with no extra context. The text is additional context. The stage assignment wins on conflict. Project skills, extensions, prompt templates, and any other instruction file stay sealed.
- `grep`, `find`, and `ls` are part of the stage tool set on both agent backends, with or without a sandbox. Without a sandbox they search the stage's working tree. With a sandbox they are confined tools, registered the same way sandbox read and sandbox bash already are, and the host builtins of those names are not offered.
- Every path those confined tools accept goes through the same sandbox path confinement as sandbox read. The allowed roots are the sandbox workspace and, when a read-only folder is mounted into the container, that folder. A host path, a `~` path, and a `..` escape are rejected. Granted artifacts already live under the workspace and need no separate root.
- Search results share the per-turn inline cap used for read and bash. The first result of a turn is returned. Later results in that turn can be deferred once the turn's budget is spent.
- The catalog reference documents the field, the precedence, the checkout-context flag, and the sandbox search boundary. An eval config snapshot includes the effective level and the checkout-context flag, because both change results.

## Testing Decisions

A good test asserts behavior the author or the stage can observe: catalog acceptance or rejection, the reminder text, whether the attempt ends, whether a path is searched or rejected, and whether a summary instruction changed. It does not assert private helper structure.

Two existing seams cover this. One new framework is not needed.

The independence seam is the stage attempt. Catalog tests already reject bad stage bodies and resolve model precedence; the same load path should accept the three levels, apply the same precedence, treat an omission as `persistent`, reject an unknown level, and reject checkout context when there is no checkout. Stage-turn tests already script a session that stops without an envelope; those tests should show that `strict` still reminds and then stops on the current budget, and that an omitted level, `persistent`, and `open` remind with the continuation text, do not offer failure, and keep going until the hard ceiling. A separate adapter test is not required where the turn driver is what both backends call. Where a backend still has its own reminder loop, one test on that loop should show it consumes the same policy. Compaction tests should show the focus text for `strict` versus the other levels, and that the prompt version differs by level.

The search seam is the sandbox tool result. Sandbox file tests already reject a host path and read a file under the workspace. The same style should cover `grep`, `find`, and `ls`: a path inside the workspace is executed in the container, a path outside it is rejected, the read-only mount is allowed when present, and a large result is subject to the turn cap. A host stage, with no container, should be offered the same three tool names pointed at its working tree.

Prior art is the catalog load tests, the stage-turn reminder tests, the compaction focus tests, and the sandbox file-tool tests.

## Out of Scope

- Loading project skills, extensions, prompt templates, or any instruction file other than the checkout's `AGENTS.md`.
- Turning independence into a switch for the browser, Project MCP, channels, memory, secrets, or gates.
- Weakening the success envelope, artifact checks, after-phase verify, channel resend rules, or the stage environment allowlist.
- Turning compaction off, or making its budget configurable.
- Rewriting the author's stage prompt, including prompts that say to fail closed.
- A console control for the level. The catalog field is the control.
- Per-project sandbox images, network policy, and anything else the sandbox spec already defers.

## Further Notes

The give-up the author is seeing is the stack of a short quiet budget, a reminder that offers failure, a failure envelope that skips the hard checks, and a compaction line that says not to retry. This spec moves the first, second, and fourth for every stage that does not opt into `strict`. It leaves the third in place so a real failure is still a legal handoff.

`open` is not "be a coding agent in whatever repository is nearby." Method freedom and checkout context are separate because a stage's job is often unrelated to the repo the pipeline lives in.

The issue tracker and triage labels this spec workflow publishes to were not configured. The spec is this document only.
