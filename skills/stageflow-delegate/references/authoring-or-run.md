# Authoring or run

Take the lookup band. Open the named job and follow it. Do not start a run, write a throwaway task, or answer a gate from this skill.

| band | open | then |
|---|---|---|
| match | [`stageflow-run`](../../stageflow-run/SKILL.md) for that pipeline | stop |
| no match, and this session already did the matching work with readable history (this chat, or a path / paste the human supplied) | [`stageflow-session-capture`](../../stageflow-session-capture/SKILL.md) | when it reports a pipeline path, open [`stageflow-run`](../../stageflow-run/SKILL.md) for that path and stop |
| no match, and no readable history | [`stageflow-author`](../../stageflow-author/SKILL.md) | when it reports a pipeline path, open [`stageflow-run`](../../stageflow-run/SKILL.md) for that path and stop |

History is a coarse yes/no. Unsure → treat as no history.

If the authoring job stops on a blocker (it names [`stageflow-setup`](../../stageflow-setup/SKILL.md), or prints `blocked: <reason>`), print that blocker and stop. Do not retry, log in, or work around it.

**Done when** `stageflow-run` has been named, or an authoring blocker has been printed.
