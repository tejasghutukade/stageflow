import type { GuideKnowledgeTopic } from "../index.js";

export const modelsAndProvidersTopic: GuideKnowledgeTopic = {
  id: "models_and_providers",
  title: "Models and providers",
  summary:
    "How a stage's model is resolved (stage, pipeline, stageflow.yaml), what must be connected before a run works, model ids and the catalog, agent and eval models, and where credentials live.",
  body: `# Models and providers

Stages and agents run on **Pi**. A model id is \`provider/model\` (for example \`anthropic/claude-sonnet-4-5\` or \`openrouter/…\`). A provider must be connected on the Host before runs that use it can succeed.

## Connecting a provider

- Console: **Settings → Providers**, or the **Connect** page (\`#/connect\`). API key or OAuth, depending on the provider.
- CLI: \`sf providers login <id> --type api_key --api-key-env VAR\` (raw keys on the command line are refused), \`sf providers status\`.
- At Host boot: \`STAGEFLOW_PROVIDER_<ID>_API_KEY\` or \`_FILE\`. The Host writes this key back at every boot, so it returns after a restart even if someone disconnected the provider in the console.
- Credentials live in \`<credential root>/agent/auth.json\` (default \`~/.stageflow/agent/auth.json\`). They are never put into a stage's environment.
- There is no tool to log in, log out or add a provider key. Guide can only look: \`list_providers\`, \`list_models\`, \`get_health\`.

## How a stage's model is chosen

Resolved at pipeline load:

\`\`\`text
stage.model ?? pipeline.model ?? stageflow.yaml model
\`\`\`

- Pipeline \`model\` is read only from the root pipeline file, not from included fragments. When it fills a stage, \`validate\` warns \`pipeline.model_applies\` (just information).
- If all three are empty, the pipeline does not load: "model is required (set on stage, pipeline, or stageflow.yaml)". There is no silent fallback for stages.
- Validation does not check that the provider is connected. A missing key shows up when the run starts.
- \`agent\` (pipeline or manifest) picks the backend, \`pi\` by default. It is separate from \`model\`. The Claude backend lacks \`send_message\` and memory tools.
- \`create_stage\` without a \`model\` writes the Host's current default model into the new stage file, so that stage no longer follows a pipeline default. Pass the model you want. \`edit_stage\` merges fields and cannot remove one; to let the pipeline default apply, rewrite the stage file without \`model\` using \`write_catalog_file\`.

## The model catalog

One catalog feeds every picker, \`list_models\` and the default model.

- Only connected providers appear. Lists are fetched live and cached for 30 seconds, with a built-in fallback when a provider is unreachable.
- Any \`provider/model\` id can be typed; an id no connected provider lists is saved and runs as written, with a warning.
- The catalog default (used by pickers, by \`create_stage\`, and by the Workshop) is: \`stageflow.yaml\` \`model\`, then the Workshop model in Settings, then the catalog's pick (a free OpenRouter model when connected, else the first free model, else the first model; never a Cursor model while another exists). This does not change stage resolution above.
- Cursor models (\`cursor/…\`) need a Cursor API key. Agents refuse Cursor models unless the Host sets \`STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1\`, because Cursor runs its own file and shell tools and grants cannot hold (\`agent.model_native_tools\`).

## Agents

\`model: { backend: pi, id, thinking }\`. \`id\` defaults to the project default model. \`thinking\` is \`off\`, \`low\`, \`medium\` (default) or \`high\` for models that support it. An unknown id only warns (\`agent.model_unknown\`).

## Evals

The stage or agent may use any provider. Judges and the agent simulator must be \`anthropic\`, \`openai\` or \`openrouter\` with an API key (OAuth logins cannot judge). The eval's \`defaults.model\` (or a run override) replaces the target's model for that eval.

## Workshop chat model

A new Workshop chat uses \`stageflow.yaml\` \`model\`, then the Settings Workshop model, then \`cursor/auto\`.

## Cost

Run and agent cost come from provider token reports. A provider that reports no cost adds nothing to totals. Overview "spend" sums stage attempt costs. Agent \`limits.cost_usd\` and eval \`max_cost_usd\` are the cost brakes; pipelines have no run-level cost cap field.
`,
};
