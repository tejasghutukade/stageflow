import type { GuideKnowledgeTopic } from "../index.js";

export const triggersTopic: GuideKnowledgeTopic = {
  id: "triggers",
  title: "Triggers: manual, schedule and event",
  summary:
    "Trigger YAML, catalog vs dynamic task mode, manual / schedule (cron) / event (GitHub pull requests, signed webhook, email) adapters, which combinations work, and the trigger tools.",
  body: `# Triggers

A trigger file is \`<id>.trigger.yaml\`. It binds one id to an existing pipeline (and usually a task) so a run can start without someone picking files. Agent schedules are different: an agent's own \`schedule\` field starts an agent turn, not a pipeline run.

## Fields

| Field | Required | Meaning |
|---|---|---|
| \`id\` | yes | Trigger id, unique in the project. |
| \`pipeline\` | yes | Id of a catalog pipeline. |
| \`task\` | no | Id of a catalog task. Its presence is the mode switch (below). |
| \`kind\` | yes | \`manual\`, \`schedule\` or \`event\`. |
| \`enabled\` | yes in the file | A disabled trigger refuses to fire (409). \`create_trigger\` defaults it to \`true\`. |
| \`schedule\` | for \`schedule\` | \`{ cron, timezone? }\`. Cron is checked when created. |
| \`event\` | for \`event\` | \`{ source, match?, config? }\`. |

The pipeline and task ids must exist in the catalog; \`create_trigger\` refuses unknown ids (422) and \`validate\` reports \`trigger.unknown_pipeline\` / \`trigger.unknown_task\`.

## Catalog mode vs dynamic mode

- **\`task\` set (catalog mode).** Every fire runs that task. Passing a task at fire time is refused (\`trigger.task_override_not_allowed\`).
- **\`task\` absent (dynamic mode).** Every fire must supply a task. GitHub, webhook and email adapters build one from the event. A manual fire must pass one inline (\`fire_trigger\` with \`task\`, or \`sf trigger fire --task-inline\`), else \`trigger.task_required\`. The console's Fire button is disabled for dynamic triggers.

## Kinds

**manual.** Fires only when asked: console Fire, \`fire_trigger\`, \`sf trigger fire\`, \`POST /api/triggers/<id>/fire\`.

**schedule.** While a Host is running, a scheduler checks about every 30 seconds and fires when the cron time passes. If the Host was down, it fires **once** for the latest missed time, not once per missed slot. A schedule trigger needs a catalog task: in dynamic mode the timer has no task, so every automatic fire fails with \`trigger.task_required\`. The console blocks that combination on save; \`create_trigger\` does not, so check it yourself.

**event, \`source\` starting with \`github.\`** (console tile uses \`github.pull_request\`). Polls the GitHub pull request list of \`event.config.repo\` (\`owner/repo\`) about every 60 seconds, with a token from \`event.config.secretRef\` (default \`GITHUB_TOKEN\`). Only pull requests, not issues or repo pushes outside a PR. The first poll of a repo only records a cursor (and per-PR head SHAs) and fires nothing for old PRs; the same quiet baseline runs when a cursor already exists but heads were never written (upgrade). \`match.action\` is **required** for github sources — \`create_trigger\` / validate reject omit-match. Actions: \`opened\` (brand-new PR: equal created/updated timestamps, or created after the cursor), \`synchronize\` (head SHA changed — use this for every push), \`updated\` (other activity, same head; also aged PRs with no prior SHA), \`merged\`, \`closed\`. \`match\` can also filter \`author\` and the other normalized fields; exact equality only.

**event, \`source: webhook\`.** Gets its own endpoint \`POST /api/triggers/<id>/webhook\`, verified by HMAC-SHA256 over the raw body. \`event.config\`: \`secretRef\` (required, name of the Host secret), \`header\` (required, for example \`x-hub-signature-256\`), \`scheme\` (\`hex\` default or \`base64\`). Wrong signature is 401. A body that does not match \`match\` returns 200 with \`fired: false\`. The Host listens on loopback by default, so an outside sender needs a tunnel or an exposed deployment.

**event, \`source\` starting with \`email.\`** (console uses \`email.message\`). Holds an IMAP IDLE connection to a mailbox the user supplies. \`event.config\`: \`host\`, \`port\`, \`user\`, \`secretRef\` (password or app password). \`match\` compares \`from\`, \`subject\`, \`date\`, \`text\` by exact equality (a subject filter must equal the whole subject). No attachments. After creating or changing an email trigger, restart the Host if the mailbox does not connect.

**Any other \`event.source\`** loads and validates but nothing watches it. It can only be fired manually.

## What works end to end

| Setup | Works automatically |
|---|---|
| manual + catalog task | fires when asked |
| schedule + catalog task | yes |
| schedule + no task | no, every tick fails |
| GitHub PR + catalog or dynamic | yes |
| webhook + catalog or dynamic | yes, if reachable and the secret is set |
| email + catalog or dynamic | yes, with a real mailbox and the secret set |
| other event source | no, manual fire only |

All automatic triggers need a running Host (\`sf ui\`, \`sf mcp\` or Docker). They do not run from the CLI alone.

## Secrets

Trigger secrets are referenced by name (\`secretRef\`) and read from the Host environment or a \`_FILE\` variant. Never put a token or password in trigger YAML.

## Tools

\`list_triggers\`, \`get_trigger\`, \`create_trigger\` (\`directory\`, \`id\`, \`pipeline\`, optional \`task\`, \`kind\`, \`schedule\`, \`event\`, \`enabled\`), \`update_trigger\` (replaces the whole definition; the id cannot change), \`set_trigger_enabled\`, \`fire_trigger\`. There is no delete tool: to stop a trigger, disable it; removing it means deleting the file by hand.

## Before you add a trigger

Run the pipeline once by hand with the same task and confirm it succeeds. A trigger repeats whatever the pipeline does, including its cost and any messages it sends.
`,
};
