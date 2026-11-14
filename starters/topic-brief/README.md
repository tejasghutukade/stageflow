# Topic brief

The smallest useful pipeline: one stage turns a topic into a one-page brief.

**What it shows**

- A task passes structured `input` (`topic`, `audience`) to the first stage.
- The stage's `io.input.schema` checks that input before the stage starts.
- The stage saves a file (`brief.md`) and returns structured output (`title`, `summary`, `key_points`, `open_questions`) checked against `io.output.schema`.

**Try it**

Run the `topic-brief` pipeline with the `topic-brief` task. When the run finishes, open the stage to read `brief.md` and the output.

**Make it yours**

Edit `topic-brief.task.yaml` and change `topic` and `audience`, or create a new task with your own values. To change the brief's format, edit the instructions in `write-brief.yaml`.
