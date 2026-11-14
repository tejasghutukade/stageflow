# Triage and route

One stage sorts an incoming request, and the pipeline sends it to the matching handler. Only one of the three handlers runs; the other two are skipped.

**What it shows**

- Conditional routing: each `route` entry on `classify` has an `if` that checks the `category` field of its output.
- Routing is decided by Stageflow, not by the agent: `classify` only reports a category, and the `if` rules pick the next stage.
- An `enum` in `io.output.schema` keeps the category to the three values the routes expect.

**Try it**

Run the `triage-and-route` pipeline three times, once with each task: `triage-bug-report`, `triage-question` and `triage-feature-request`. Each run takes a different path; the stages that don't match show as skipped.

**Make it yours**

Paste a real message into a task's `message`. To add a category, add it to the `enum` and the instructions in `classify.yaml`, create a handler stage, and add a `route` entry with a matching `if`.
