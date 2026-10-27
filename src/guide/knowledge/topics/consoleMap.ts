import type { GuideKnowledgeTopic } from "../index.js";

export const consoleMapTopic: GuideKnowledgeTopic = {
  id: "console_map",
  title: "Console map: where things live",
  summary:
    "The operator console's sidebar sections and hash routes (#/inbox, #/pipelines, #/agents, #/triggers, #/connections, #/memories, #/evals, #/settings, …) and what to do on each page.",
  body: `# Console map

The console runs at the Host's address (\`sf ui\`, default \`http://127.0.0.1:3847\`). Pages are hash routes, so a link looks like \`#/pipelines\`. When you tell a user where to look, give the sidebar label and the route.

## Sidebar

**Top**
- **Guide** — \`#/guide\`. This chat.
- **Overview** — \`#/overview\`. What needs you, runs in flight, system health (agent slots, providers, connections needing attention, triggers armed, disk), KPIs and spend for 24h / 7d / 30d.
- **Inbox** — \`#/inbox\` (home page). Tabs: **Needs you** (pipeline gates and agent approvals; answer here), **Failed** (\`#/inbox?tab=failed\`, retry a stage), **Done today** (\`#/inbox?tab=done_today\`).

**Activity**
- **Pipeline runs** — \`#/runs\`. Run list with filters. A run: \`#/runs/<runId>\`; a stage: \`#/runs/<runId>/stages/<stageId>\` (Transcript, Events, Envelope, Artifacts, and Retry / Resume / Abandon / answer panel); the envelope: \`#/runs/<runId>/stages/<stageId>/envelope\`; an artifact: \`#/runs/<runId>/artifacts?path=…\`.
- **Agent sessions** — \`#/agent-sessions\`. Sessions across all agents.

**Build**
- **Pipelines** — \`#/pipelines\`. List; **New pipeline** opens the Workshop. One pipeline: \`#/pipelines/<id>\` opens the pipeline editor (stage graph, inspector with the stage **Channels** section, YAML panel, Problems panel with quick fixes; tabs Editor, Runs, History).
- **Agents** — \`#/agents\`. Directory with status (Enabled, Disabled, Needs setup) and reach. New: \`#/agents/new\` (form plus author chat; always created disabled). One agent: \`#/agents/<id>\` (Enable/Disable, web chat card, Sessions, Configuration); edit: \`#/agents/<id>/edit\` (tools, approvals, limits, channel, schedule, web chat, version history, Remove = archive). A session: \`#/agents/<id>/sessions/<sessionId>\`; one turn: \`…/runs/<runId>\` (Steps, Waterfall, Messages, Logs, Configuration).
- **Tasks** — \`#/tasks\`. Task files with their last run; one task: \`#/tasks/<id>\`.
- **Catalog** — \`#/catalog?tab=stages\`. Stage files (\`#/stages/<path>\` opens one) and **Skills** (\`#/catalog?tab=skills\` or \`#/skills\`; install a skill here).
- **Evals** — \`#/evals\`. List with status (never run, running, passing, failing, regressed, saturated) and **Try the sample eval**. New: \`#/evals/new\`. One eval: \`#/evals/<id>\`, edit \`#/evals/<id>/edit\`, a run \`#/evals/<id>/runs/<n>\` (tabs Overview, Cases, Graders, Config), a case \`…/case/<caseId>\`, compare \`#/evals/<id>/compare\`. Datasets: \`#/datasets\`, \`#/datasets/<id>\`.

**Connect**
- **Triggers** — \`#/triggers\`. Create (N), Fire (F, only enabled triggers with a catalog task), enable/disable (E). One trigger: \`#/triggers/<id>\`. The form edits \`event.source\` but not \`event.config\`.
- **Connections** — \`#/connections\`. Communication channels, email accounts and MCP tool servers. **Add connection**, Test connection. One connection: \`#/connections/<id>\` (status, "Use in a stage" snippet, Enable/Disable, replace key, Disconnect).
- **Memories** — \`#/memories\`. Create a memory, edit its cover, open, correct or delete cards. One memory: \`#/memories/<id>\`.

## Not in the sidebar

- **Start a run** — \`#/new\` (also the rail button). Pick a task and a pipeline; shows provider and validity before starting. \`?pipeline=\` and \`?task=\` preselect.
- **Workshop** — \`#/workshop\`. Design a pipeline by chat; opened from Pipelines (New pipeline, or Open in Workshop). Saves to \`workshop/<pipeline-id>/\` unless told otherwise.
- **Settings** — \`#/settings\` (rail footer). Sections: General (Workshop model, disk), Providers (connect, replace key, sign in again, disconnect), Concurrency (agent slots), MCP server (this console's own MCP address), Project MCP (add servers, Check, Sign in, MCP secrets), Notifications (desktop notification when a gate or approval opens).
- **Connect** — \`#/connect\`. Guided provider setup.
- **Public web chat** — \`/chat/<slug>\` on the Host (not a console page). Live only while the agent and its web chat are enabled.

## Where to send the user for common jobs

| Job | Page |
|---|---|
| Answer a question a stage asked, approve an agent action | Inbox \`#/inbox\` |
| See why a run failed | \`#/runs/<runId>\`, open the stage, Transcript and Envelope |
| Connect a model provider | Settings → Providers, or \`#/connect\` |
| Add an MCP server or MCP secret | Settings → Project MCP |
| Add Slack / email / Telegram / iMessage / WhatsApp | Connections → Add connection |
| Install a skill | Catalog → Skills |
| Change a stage's channel recipient | Pipeline editor → select stage → Channels |
| Enable an agent, share its web chat link | \`#/agents/<id>\` |
| Delete a memory card | \`#/memories/<id>\` |
| Run or compare an eval | \`#/evals/<id>\` |
`,
};
