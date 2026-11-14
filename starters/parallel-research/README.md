# Parallel research

Five stages, three of them running at the same time. `frame` sets up the question. `case-for`, `case-against` and `practical-impact` each look at it from a different side at the same time. `synthesize` waits for all three and writes a recommendation.

**What it shows**

- Fan-out: `frame` routes to three stages, and they run in parallel.
- Fan-in (a join): `synthesize` has three parents, so it starts only after all three finish, and it receives each parent's output.
- Typed handoffs: each stage's `io.input.schema` must fit the output of the stage before it. `sf validate` checks this before anything runs.

**Try it**

Run the `parallel-research` pipeline with the `parallel-research` task. Watch the three middle stages run side by side, then read `recommendation.md` on the `synthesize` stage.

**Make it yours**

Change `question` and `background` in the task to a decision you are facing. To add a viewpoint, copy one of the middle stage files, give it a new `id` and instructions, and add it to the pipeline with a `route` to `synthesize`.
