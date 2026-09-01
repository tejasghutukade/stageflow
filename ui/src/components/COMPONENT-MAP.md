# Component Map

Inventory mapping prototype concepts to React modules.

| Prototype pattern | Module path | Status | Notes |
|---|---|---|---|
| AppChrome / Rail | `components/AppRail.tsx` | wired | Native `.rail` ported from prototype CSS (Phase 6). Brand mark, Start a run button, seven nav items with glyph + label, capacity footer. Used in `App.tsx`. Waiting count badge on Today. |
| Today / Home | `pages/TodayPage.tsx` | wired | Default landing (`#/today`). Buckets enriched `RunSummary` into four zones. Waiting cards (question, peek excerpt, narrow Accept) live here, not a separate component. |
| TodayTriage | `components/TodayTriage.tsx` | wired | Four zones: waiting / inFlight / broken / finished. Native `.zone` + `.zone__head` (dot + eyebrow + rule + count) ported from prototype CSS (Phase 6). Used by TodayPage. |
| Placeholder library pages | `pages/PlaceholderPages.tsx` | removed | Settings stub replaced in Phase 5. |
| Settings page | `pages/SettingsPage.tsx` | wired | Appearance, Providers (API keys + OAuth + credential source), MCP connection instructions, session-slot select via `POST /api/settings`, held-stage copy, notify preference. First-run/connect gate at `#/connect`. |
| SettingsAppearance | `components/SettingsAppearance.tsx` | wired | Theme picker (System / Light / Dark) via `.theme-picks` / `.theme-pick` swatch cards ported from prototype CSS (Phase 6). |
| SettingsProviders | `components/SettingsProviders.tsx` | wired | Live Pi provider list, API-key + OAuth connect/disconnect, credential source (`pi_home` \| `sf_owned`). OAuth uses `ProviderOAuthSession` AuthInteraction bridge. |
| ProviderOAuthSession | `components/ProviderOAuthSession.tsx` | wired | Interactive OAuth login session: auth_url / device_code / prompts, paste fallback, cancel. Used by Settings + first-run. |
| SettingsMcp | `components/SettingsMcp.tsx` | wired | Streamable HTTP MCP how-to: endpoint URL, Cursor `.cursor/mcp.json` snippet, tools, HITL caveat. |
| New Run capacity `.gate` | `pages/NewRunPage.tsx` | wired | Inline `.gate` warning when `slotsAvailable === 0`; Start run disabled. Pipeline preview (`.track--inline`) when selected. Not a separate component. |
| SpatialRunMap | `components/SpatialRunMap.tsx` | wired | Run-detail live pane. Chrome exception (`graph-view`, `gnode`, `canvas-tools`, `canvas-hint`). Takes `spatialLayout` + `nodeChrome` from the workspace (not `TrackDetailRow` / `trackLayout`). SVG + CSS transform spatial map with pan/click, Fit run, node status column, and handoff-styled wires. `canvas-hint` shows only while the workspace is hidden (`showHint` from the page). Replaces `RunTrack` on `RunDetailPage` only. Session logs live in the workspace `TranscriptStream`. Envelope records open from the files aside, not from edge chips. Selecting a stage writes `#/runs/:id/stages/:stageId`. |
| PipelineTrack | `components/PipelineTrack.tsx` | wired | Horizontal stage nodes + envelope chips. `mode="definition"` on pipeline detail (lines only). Not used on run detail. |
| RunTrack | `components/RunTrack.tsx` | unused on run detail | Facade for linear `PipelineTrack` or DAG `PipelineDagTrack` plus `TrackDetailList`. Kept as a module; `RunDetailPage` uses `SpatialRunMap` instead. |
| PipelineDagTrack | `components/PipelineDagTrack.tsx` | unused on run detail | Horizontal layered mini-DAG. Kept for `RunTrack` / `TrackLayout` types. Not mounted on run detail. |
| TrackDetailList | `components/TrackDetailList.tsx` | unused on run detail | Dependency-aware stage rows. Folded onto spatial nodes and the workspace header. Module kept; not rendered on run detail. |
| AttemptCountBadge | `components/AttemptCountBadge.tsx` | wired | Compact `×n` chip when `attempt_count > 1`. Used in track detail rows and transcript stream header. |
| useStageRetry | `stageAction/useStageRetry.ts` | wired | In-flight stage retry state, error handling, post-success refresh callback, and retry affordance when stage status is `failed`. |
| useStageAbandon | `stageAction/useStageAbandon.ts` | wired | In-flight stage abandon state, confirm dialog, error handling, post-success refresh callback, and abandon affordance when stage status is `running`. |
| StageNode | `components/StageNode.tsx` | wired | Single pipeline node with status ring, label, optional meta. Pending omits `onClick`. |
| StageWorkspace | `workspace/resolveRunWorkspace.ts` | wired | Pure graph projection: selected stage, workspace kind, composer, decide, drawer, `spatialLayout`, `nodeChrome`, and `trackStages`. Does not return `trackLayout` or `detailListRows`. Stream hide/deep-link is a `resolveStreamRoute` command applied by the page. Stream `view.stageId` from `#/runs/:id/stages/:stageId` selects that stage. Unknown ids stay map-only. `RunDetailPage` renders it. |
| TranscriptStream | `components/TranscriptStream.tsx` | wired | Scrollable transcript chrome (head + body + pinned composer). Owns the stream header (compact status, chips, Retry/Abandon, trailing Hide). Auto-scrolls while running or waiting. Session alive/closed chip is composed in `RunDetailPage`. |
| TranscriptTurns | `components/TranscriptTurns.tsx` | wired | Maps `StageLogEvent` into envelope / tool / message / ask / answer / system turns. |
| ArtifactAside | `components/ArtifactAside.tsx` | wired | Run-wide file list + Input footer. `onSelect` opens `ArtifactReader`. |
| EnvelopeDrawer | `components/EnvelopeDrawer.tsx` | wired | Native `.drawer` bottom sheet from track wire. “Open full record” navigates to envelope workspace. |
| EnvelopeFields / EnvelopeRecord | `components/EnvelopeFields.tsx` | wired | Shared `.drawer__grid` + `.kv` body; full record is a run-shell workspace (`#/runs/:id/stages/:stageId/envelope`). Owns the reader header (clone-aware `from → to`, ← Transcript, Hide). |
| ArtifactReader | `components/ArtifactReader.tsx` | wired | Center-column markdown/code viewer. Owns the reader bar (name, ← Transcript, Hide, Rendered/Raw). Diff disabled. Hash `#/runs/:id/artifacts?path=`. |
| DecidePanel / ArtifactDecideColumn | `components/DecidePanel.tsx` | wired | Sticky accept/reject + notes, history, inbound context for `artifact_backed` review. |
| ReplyZone | `ReplyZone.tsx` | exists | Multi-kind operator reply form. Pinned as stream composer; “Review side by side” for `artifact_backed`. |
| useStageAnswer | `useStageAnswer.ts` | exists | Shared submit/error/lock for ReplyZone and decide column. |
| StatusLabel | `StatusLabel.tsx` | exists | Inline `.status` + `.dot` from prototype CSS. Used in transcript stream and run detail. |
| StageActivityLog | `StageActivityLog.tsx` | exists | Timestamped event list with raw JSON collapsible. Unused on run detail after Phase 2. |
| PipelineList | `pages/PipelinesPage.tsx` | wired | Catalog table + stage library; detail at `#/pipelines/:id` with definition track and run history. |
| TaskList | `pages/TasksPage.tsx` | wired | Task table + detail at `#/tasks/:id`. Last-run joined client-side on `task_id`. |
| SkillList | `pages/SkillsPage.tsx` | wired | Pi skill catalog table + detail at `#/skills/:name`. One-shot `GET /api/skills`; stages stay sealed. |
| ExtensionList | `pages/ExtensionsPage.tsx` | wired | Pi package + extension-file catalog at `#/extensions`. Package detail `#/extensions/packages/:scope/:source`; file detail `#/extensions/files/:path`. One-shot `GET /api/extensions`; stages stay sealed. |
| Mini-track | `components/MiniTrack.tsx` | wired | Compact `.mini` ring nodes (`.mini__n` / `.mini__w` with `data-s` / `data-flowed`) from list `stages`. Runs page and Pipelines page rows. Today in-flight uses `.track-mini` bar segments instead (not MiniTrack). |
| Empty/Error states | inline | wired | Native `.empty-hint` (dashed border) from prototype CSS (Phase 6). Inline in pages, not a separate component. |
| Barrel export | `components/index.ts` | exists | Re-exports wired and skeleton components and their types. |
| Run catalog | `catalog/` | wired | One poll, one cache, one error. Views: waiting, in-flight, broken, finished, capacity, per-task, per-pipeline. Seam `CatalogSource` with HTTP (`httpSource.ts`) and in-memory (`memorySource.ts`) adapters. React binding is `useRunCatalog.ts` only. Mounted once in `App.tsx` via `RunCatalogProvider`; pages select views. `fetchRuns` / `fetchHealth` live only in `httpSource.ts`. |
