import type { GuideKnowledgeTopic } from "../index.js";

export const artifactsTopic: GuideKnowledgeTopic = {
  id: "artifacts",
  title: "Artifacts: publish, index, and find deliverables",
  summary:
    "Published and indexed artifacts (static kinds, opt-in publish_artifact, stage artifacts YAML, agent grants, console Artifacts page, sf artifact and MCP get_artifact/save_artifact/delete_artifact, versions, expiry, and error codes).",
  body: `# Artifacts

Stageflow uses the word **artifact** in three places. Keep them separate:

1. **Envelope \`artifacts\` list** — string paths on a success envelope. The Host **indexes** those run files when the attempt succeeds. They follow run retention and can expire.
2. **\`publish_artifact\`** — an opted-in stage or an agent with \`artifacts.write\` copies content into the **keep-class store** with a stable author id. Versions stay when the run is deleted.
3. **Function \`access.artifacts\`** — which run files a **function** may read. That is not the artifact index.

This topic covers (1) indexing and (2) publishing. A live artifact (\`live.declarative\`) stores an OpenUI Lang program (format openui-lang, library stageflow 1.0.0) and read-only function bindings. Publish rejects an invalid program with artifact.program_invalid. Refresh runs those bindings from the CLI (\`sf artifact refresh\`), MCP (\`refresh_artifact\`), or the console **Refresh now** button. The visual renderer comes later.

## Opt in

**Stage:** add a body field (stage file or inline stage, not pipeline-level):

\`\`\`yaml
artifacts:
  publish: true
  expect: [weekly-report, metrics-table]
\`\`\`

\`publish: true\` registers \`publish_artifact\` and a short prompt section. Omit the block or set \`publish: false\` and behavior is unchanged. \`expect\` lists ids the attempt must publish before a success envelope; a missing id is \`artifact.expected_missing\`. \`expect\` without \`publish: true\` is \`stage.invalid_artifacts\` at validate time.

**Agent:** grant \`tools.stageflow.groups\`: \`artifacts.read\` (model tool \`stageflow_get_artifact\`), \`artifacts.write\` (\`publish_artifact\`), \`artifacts.cleanup\` (\`stageflow_delete_artifact\`), \`artifacts.refresh\` (\`stageflow_refresh_artifact\`, this agent's artifacts in this project only). Put \`publish_artifact\`, \`stageflow.get_artifact\`, \`stageflow.delete_artifact\`, and \`stageflow.refresh_artifact\` in \`approvals.ask_first\` when those groups are granted. The Host MCP tool \`save_artifact\` is operator-only; agents never receive it.

## Publishing

Tool \`publish_artifact\` takes \`id\`, \`kind\`, \`title\`, optional \`description\`, \`tags\` (max 8), \`summary\`, and one of \`path\`, \`content\`, or \`content_base64\`.

Static kinds: \`static.markdown\`, \`static.image\`, \`static.table\`, \`static.text\`, \`static.html\`. Id: \`^[a-z][a-z0-9_-]{0,63}$\`, no \`::\`. Title at most 120 characters. Content cap 5 MiB. Host keeps the latest \`STAGEFLOW_ARTIFACT_VERSIONS_KEEP\` versions (default 10). Same bytes and kind republish returns \`unchanged: true\` without a new version.

Stages: \`path\` must stay inside the attempt \`artifacts/\` directory. Agents: \`path\` is project-relative under the path guard (no \`..\`, symlinks, or \`agents/*.agent.yaml\`).

Pick **envelope listing** when the file is only for the next stage or run retention is enough. Pick **publish** when operators should search for it later on the Artifacts page, keep versions, or an agent should read it across sessions.

## Find artifacts

| Surface | Use |
|---|---|
| Console | **Artifacts** in the Activity sidebar, \`#/artifacts\`. Filter by kind, owner, tag, status. Detail: \`#/artifacts/<ownerKey>/<id>\`. |
| CLI | \`sf artifact list\`, \`sf artifact show <ownerKey>/<id>\`, \`sf artifact publish\` (\`--manifest\` for \`live.declarative\`), \`sf artifact refresh\`, \`sf artifact delete\`. \`sf artifact read --run --path\` reads a **run file**, not the index. |
| MCP | Toolset \`artifacts\`: \`get_artifact\` (list or read; \`view: data\` for live snapshots), \`save_artifact\`, \`refresh_artifact\`, \`delete_artifact\`. Bare \`/mcp\` does not load it; add \`?toolsets=artifacts\` or \`all\`. |
| Run | Indexed paths from the envelope appear on the stage **Artifacts** tab and in \`run_files\`. Published rows appear in \`published_artifacts\` on \`sf run --json --include stages\`. |

Use \`--project-root\` when the same owner and id exist in more than one project (\`artifact.ambiguous\`).

## Expiry and backup

Indexed rows get \`expires_at\` from run retention and may show \`expired_reason\` (\`run_slimmed\`, \`run_purged\`, \`run_deleted\`, \`file_missing\`). Published rows are not expired by run retention. \`sf backup\` and \`sf archive\` include the keep-class \`artifacts/\` directory and artifact tables in \`state.db\`.

## Error codes

| Code | Meaning |
|---|---|
| \`artifact.invalid_id\` | Bad or missing id or owner slug, or \`::\` in an id |
| \`artifact.invalid_kind\` | Kind not one of the static kinds |
| \`artifact.invalid_shape\` | Wrong field shape, tags, title, UTF-8, table CSV/JSON, base64 |
| \`artifact.too_large\` | Content over 5 MiB |
| \`artifact.expected_missing\` | Stage \`expect\` id not published before success emit |
| \`artifact.not_found\` | Key or version missing (agent delete of another owner's key too) |
| \`artifact.ambiguous\` | Same owner and id in more than one project without \`project_root\` |
| \`artifact.not_deletable\` | Delete on an indexed-only row |
| \`stage.invalid_artifacts\` | Bad \`artifacts:\` block or \`expect\` without \`publish: true\` |

Walkthrough: repository \`examples/artifacts/\`. Fixture shape: \`tests/fixtures/pipelines/publish-note.pipeline.yaml\` and \`publish-report\` for two published ids.
`,
};