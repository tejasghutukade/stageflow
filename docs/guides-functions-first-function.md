---
layout: default
title: Create your first function
---

# Guide: create your first function

This guide builds a verification function, tests it, attaches it to a stage, and then gives it a little access to show how grants work. It takes about ten minutes. For the ideas behind it, see [Functions](functions.md).

You need a running console (`sf ui`, or the Docker image) and a project with one pipeline.

## 1. Write the function

**Console.** Open **Functions** (`#/functions`) and choose **New function**. Pick **Verification**, name it `Score gate`, and leave the id as `score_gate`. Replace the code with:

```js
export const access = {
  artifacts: "none",
  env: [],
  network: [],
};

export default function execute(context) {
  const score = context.envelope.payload.score;
  if (typeof score !== "number") {
    return { passed: false, message: "payload.score must be a number" };
  }
  const passed = score >= 70;
  return {
    passed,
    message: passed ? "Score " + score + " is at least 70" : "Score " + score + " is below 70",
    details: { score },
  };
}
```

Choose **Create function**.

**Files.** Save the same thing as `functions/score_gate.function.yaml`. The file name is the id:

```yaml
id: score_gate
name: Score gate
description: Passes when payload.score is at least 70.
kind: verification
source: |
  export const access = {
    artifacts: "none",
    env: [],
    network: [],
  };
  export default function execute(context) {
    const score = context.envelope.payload.score;
    if (typeof score !== "number") {
      return { passed: false, message: "payload.score must be a number" };
    }
    const passed = score >= 70;
    return {
      passed,
      message: passed ? "Score " + score + " is at least 70" : "Score " + score + " is below 70",
      details: { score },
    };
  }
```

The `access` block is empty on purpose: this function only looks at the envelope it is given, so it needs no files, variables or network. A verification receives the stage's success envelope as `context.envelope` and returns `{ passed, message?, details? }`.

## 2. Test it

Open the function and scroll to **Test**. The sample context is already shaped for a verification. Set it to:

```json
{ "envelope": { "payload": { "score": 82 } } }
```

Choose **Run test**. You should see **Succeeded** and a result of `{ "passed": true, "message": "Score 82 is at least 70", "details": { "score": 82 } }`. Change `82` to `61` and run again: the call still *succeeds* (the function ran), and its result is `passed: false`. A check that returns `passed: false` is what fails a stage.

The test shows exactly what your function returned. The rules for a kind's result (a verification may only return `passed`, `message` and `details`, and `passed` must be a boolean) are applied when a stage uses it, so check the shape yourself here.

## 3. Attach it to a stage

A function does nothing until a stage attaches it. In the stage body, add a `verify` check of type `function`:

```yaml
id: review
stages:
  - id: write-score
    model: anthropic/claude-sonnet-5-5
    system_prompt: |
      Emit a success envelope whose payload is { "score": 82 }.
    io:
      input:
        schema:
          type: object
          additionalProperties: false
      output:
        schema:
          type: object
          required:
            - score
          properties:
            score:
              type: integer
          additionalProperties: false
    verify:
      - id: score-accepted
        type: function
        function: score_gate
```

In the console you can do the same from the pipeline page: select the stage, open the **Functions** panel in the inspector, and pick `Score gate` under **Checks**.

Check it before you run anything:

```bash
sf validate --pipeline pipelines/review.pipeline.yaml
```

A clean result means the function exists, has the right kind, and every capability it asks for is granted. This function asks for none, so there is nothing to grant.

Run it with `sf run --pipeline pipelines/review.pipeline.yaml --task <your task file>`. The stage emits its envelope, the check runs `score_gate` on it, and the stage passes when `passed` is true. The call appears under **History** on the function's page.

## 4. Give it access

Say the threshold should come from the Host's environment instead of being fixed at 70. Change the top of the function to ask for a variable:

```js
export const access = {
  artifacts: "none",
  env: ["MIN_SCORE"],
  network: [],
};
```

and read it with `Number(context.env.MIN_SCORE)` in place of `70`. Save it as a new revision.

Run `sf validate` again. It now fails:

```text
function.under_granted: Capability env_min_score is not granted on "score_gate"
```

That is the safety check doing its job. The function asked for something the stage never agreed to. Grant it in the check, using the capability id from the message:

```yaml
    verify:
      - id: score-accepted
        type: function
        function: score_gate
        grants:
          - id: env_min_score
```

`sf validate` passes again. In the console you would see **Access changed** on the attachment and choose **Review**, then **Allow**.

The value comes from the environment of the process that runs the stage, so start the run with it set (`MIN_SCORE=70 sf run …`, or `-e MIN_SCORE=70` for Docker). If it is missing the call fails with `missing_binding` before your code runs. To make it optional, write `"MIN_SCORE?"` and handle `undefined` in the code.

## 5. Where to go next

- **A routing function** picks the next stage. A **tool** gives a stage or an agent something to call, with a JSON schema. [Functions](functions.md#the-three-kinds) shows what each returns.
- The [function manual pack](https://github.com/tejasghutukade/stageflow/tree/main/examples/function-manual) has a verification, a routing function and a tool, each with a pipeline you can run by hand.
- Read files with `context.artifacts.readJson("report.json")` after setting `artifacts: "read"`. [Access](functions.md#access-what-a-function-may-touch) covers files, variables and network.
- Script it: the [Functions API](function-api.md) and the [MCP tools](mcp.md#function-tools) create, save and test functions.
- If something fails, [Troubleshooting](functions.md#troubleshooting) maps each message to a fix.
