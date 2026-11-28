---
layout: default
title: Generative UI internals
---

# Generative UI internals

For contributors and coding agents. Generative UI is everything a model draws for a person: cards in chat (`present_ui`), showing a saved artifact, keeping a card as an artifact (`save_card`) and publishing artifacts (`publish_artifact`). This page says where that code lives and how to change it. User-facing behaviour is in [Artifacts](artifacts.md), [Agent definition: ui](agent-definition.md#ui) and [Web chat](guides-agents-web-chat.md). If this page and the code disagree, the code wins. Fix this page.

## The idea

One core module, `src/genui/`, owns kinds, validation, limits, the operations, prompt text and the tool definitions. A caller (a stage attempt, a project agent session, a public chat visitor's session, the Guide) does not reimplement any of it. It describes itself as a **Surface** and gets its tools through a thin adapter. Changing card behaviour means editing `src/genui/`, plus one console renderer when a new kind is added.

`src/genui/` imports nothing from `src/agents/`, `src/guide/`, `src/operatorAgent/`, `src/tools/` or `src/mcp/`. It may use `src/artifacts/` (store, publish, ui parts) and `src/config/` types.

## Module map

| File | Job |
|------|-----|
| `kinds.ts` | The kind registry. One `GenUiKind` per kind (`live.declarative`, `live.html`, `static.markdown`, and the static artifact-only kinds): byte limits for card and artifact mode, `canBeCard`, `presentable`, `parse` (manifest shape), `check` (program against the project), `toArtifactManifest`. `genUiKind(id)` looks one up. |
| `validate.ts` | The one validation entry (`validateGenUi`, `parseGenUiManifest`, `checkGenUiContent`, `assertGenUiSize`). Card checks and publish checks (`src/artifacts/publish.ts`) both go through it; card-only rules are `mode: "card"`. |
| `kindsList.ts` | Plain kind lists (`PRESENTABLE_ARTIFACT_KINDS`, `CONVERSATION_CARD_KINDS`, `PUBLISH_KINDS`, `STATIC_KINDS`, `UI_PERSISTENCE_VALUES`). It imports only `src/artifacts/kindNames.ts`, so the console can type-check it. |
| `surface.ts` | `SurfacePolicy`, `Surface`, `PublishPort`, `ArtifactStoreAccess`, `surfaceKey`, and the helpers `uiPolicy` (from an agent's `ui` block), `publishOnlyPolicy` (a stage), `inlineKinds`, `htmlSignal`. |
| `budget.ts` | `TurnBudget` (cards per reply), `TurnBudgets` (one budget per surface key for a tool shared by many threads, the Guide) and the per-surface rate limiter `takeCardRate`. |
| `present.ts` | The present operations: `presentCard` (a card kept in the message), `presentInline` (a one-off program saved as a session artifact), `presentArtifact` (a saved artifact by key), `presentedTitle`. |
| `cards.ts` | The `CardSource` port (cards a conversation has shown, newest first) and `pickCard` (id, then title, then latest). |
| `save.ts` | `saveCard`: keeps a shown card as an artifact owned by the surface's owner, with a stable id per surface and card, so saving twice returns the same artifact. |
| `replay.ts` | How presented parts read back into a model's history (`messageReplayText`, `toolPartsReplayText`, `REPLAY_PROGRAM_MAX`). |
| `parts.ts` | Collects `present_ui` and `save_card` results into stored ui parts (`uiPartsFromToolOutput`). |
| `prompt.ts` | All generative UI prompt text: the card section and artifacts-mode section (`genUiPresentPrompt`) and the publish section (`genUiPublishPrompt`), built from kinds and policy. |
| `tools.ts` | The neutral tool specs `presentUiSpec(policy)`, `saveCardSpec(saver)`, `publishArtifactSpec(publisher)`: name, label, description, schema and `handler(args, surface)`. |
| `publishParams.ts` | The `publish_artifact` parameter schema and the mapping from tool arguments to a publish body. |
| `adapters/pi.ts` | `toPiTool(spec, surface)`: a Pi tool (`execute(toolCallId, params)`) for stage workers and project agents. |
| `adapters/operator.ts` | `toOperatorTool(spec, surfaceFor)`: an operator-agent tool (`handler(args, ctx)`) for the Guide, which resolves its surface per call. |
| `names.ts` | The tool names. |
| `index.ts` | The public face; also re-exports the ui part wire contract (`src/artifacts/uiPart*.ts`). |

## Concepts

- **SurfacePolicy** is what a caller lets the model do: `canPresent`, the granted `kinds`, `htmlCardsReachable()` (whether readers of this chat can reach the HTML card sandbox, read when a card is drawn and when a prompt is built), `cardsInConversation`, `canShowSaved`, `canSave`, `visitorSession`, `canPublish` and `describeKinds`. Every difference between callers is a value here, not a code path.
- **Surface** is one conversation: rate-limit `key` (built only by `surfaceKey`), `id`, `owner` (the `ArtifactOwner` it saves and presents as, and the only owner a `publish_artifact` `owner` argument may name; absent for a stage, whose publish port applies the owner), `hiddenArtifacts` (set by agent callers so an eval session's artifacts are hidden), `projectRoot`, `policy`, and its ports: `budget`, `artifacts` (store access), `publish` (`PublishPort`: read a path under the caller's rules, store the artifact) and `cards` (`CardSource`).
- **TurnBudget** counts cards in the current reply. A call reserves its slot before it awaits anything and releases it if the card fails, so parallel calls each count and a refused card does not use up the reply.
- **CardSource** lists the cards a conversation has shown. The Guide reads its thread file (`src/guide/saveCard.ts`); an agent reads its stored session messages (`src/agents/sessionCards.ts`), so a card drawn in the reply still running can be saved in the next message.

## How each caller builds its surface

| Caller | Where | Owner and policy | Tools |
|--------|-------|------------------|-------|
| Stage attempt | `src/tools/publishArtifact.ts` (`createPublishArtifactTool`) | no owner, `publishOnlyPolicy(PUBLISH_KINDS)`; the publish port reads paths inside the attempt's artifacts directory and applies the stage owner | `publish_artifact` via `toPiTool`. Prompt: `genUiPublishPrompt({ publisher: "stage" })` in `src/agent/piAdapter.ts` and `src/tools/publishArtifact.ts` |
| Project agent | `src/agents/runtime/piRuntime.ts` | `{ kind: "agent", agent }`, `hiddenArtifacts` from `agentSessionIsEval`, `uiPolicy(definition.ui, htmlSignal(...))`, `canSave` when the agent holds `save_card` and the Host has a card source and store, `canPublish` when `save_artifact` is granted | `present_ui`, `save_card`, `publish_artifact` via `toPiTool`. Prompt: `genUiPresentPrompt(surface.policy)`; publish section from `src/agents/artifactTools.ts` |
| Public chat visitor | Same as a project agent, with `visitorSession: true` when the session is anonymous (`anonymousPublicTools`) | A saved card stays in the visitor's conversation (session scope) and is visible through the visitor artifact route (`src/agents/webChat/visitorArtifacts.ts`) | Same tools, under the public-tools grant rules |
| Guide | `src/guide/presentUi.ts`, `src/guide/saveCard.ts` | `{ kind: "guide" }`; kinds and the HTML signal are resolved per session, so `describeKinds: false`; budget from `TurnBudgets` keyed by thread and turn | `present_ui`, `save_card` via `toOperatorTool`. Prompt: `genUiPresentPrompt` plus the Guide-only rules in `GUIDE_CARD_RULES` |

The HTML-cards signal comes from `src/agents/hostContext.ts` (agents) and `src/operatorAgent/piModel.ts` (Guide) and goes only into the policy.

## Add a kind

1. Add a `GenUiKind` entry in `src/genui/kinds.ts`: limits, `canBeCard`, `presentable`, `parse`, `check`, `toArtifactManifest`. Add its name to the lists in `kindsList.ts` (and `src/artifacts/kindNames.ts` for a new live kind).
2. If it can be a card, add it to `CONVERSATION_CARD_KINDS` and register a console renderer with `registerFormatRenderer(kind, { card, artifact })` in `ui/src/chat/parts/formats.tsx`. Keep a heavy renderer behind `lazy(() => import(...))`.
3. Add rows for it to `tests/genui.conformance.test.ts`.

Validation, the per-reply cap, prompts, tool descriptions, save and publish pick the new kind up from the registry.

## Add a caller

1. Build a `Surface`: pick the owner (and `hiddenArtifacts` if the caller has hidden sessions), build the policy (`uiPolicy`, `publishOnlyPolicy`, or a literal), give it a key from `surfaceKey`, a `TurnBudget`, and the ports it needs (`artifacts`, `publish`, `cards`).
2. Wrap the specs with an adapter (`toPiTool`, `toOperatorTool`, or a new adapter in `src/genui/adapters/` that maps a `GenUiToolResult` and contains no business logic).
3. Put `genUiPresentPrompt` / `genUiPublishPrompt` output in the caller's prompt. Caller-only rules stay in the caller's playbook.
4. Add the surface to `SURFACES` in `tests/genui.conformance.test.ts`.

Do not copy present, save or publish logic into the caller.

## Artifact owners

Owner-kind behaviour lives in one descriptor table, `src/artifacts/owners.ts` (`ARTIFACT_OWNERS`, one entry each for `stage`, `agent`, `guide`). A descriptor gives the key format and parse (`toKey`, `parseKey`, `keyPrefix`, `keySql`), the stored fields (each maps to an `owner_*` column), the CLI label and filter names, the search filter word, `canBind` (may a live artifact bind functions) and `workspaceContent` (may content fall back to a run workspace file). Helpers built on it: `artifactOwnerKey`, `parseOwnerKey`, `ownerColumns`, `ownerFromRow`, `ownerKeyFromRow`, `ownerSearchText` / `ownerSearchTextSql`, `ownerMatchSql`, `ownerSubstringSql`. Keys, records, list and search queries, content, publish, bindings, refresh, session publish, the visitor artifact lookup, the CLI list format and `save_card` all read it. There is no schema change: rows keep `owner_kind`, `owner_pipeline`, `owner_stage`, `owner_agent`, and `tests/artifacts.owners.test.ts` pins the generated SQL.

Adding an owner kind is one descriptor plus the `ArtifactOwner` union member; `bindings.ts` also needs a `FUNCTION_ACCESS` entry if the kind can bind.

## Console

- **Sandbox frame core**: `ui/src/redesign/artifacts/sandbox/useSandboxBridge.ts`. One hook for HTML cards (`ui/src/chat/parts/htmlCardFrame.tsx`) and the live HTML artifact view (`ui/src/redesign/artifacts/liveHtml/LiveHtmlFrame.tsx`): it builds the host bridge once per mount, relays messages with a mount epoch, binds and arms on mount and unbinds and disarms on unmount, keeps the stopped state, and applies `createHeightGuard` to reported heights on both. The guard (mirrored in the sandbox shell) locks only on three equal increases that each arrive within 250 ms of the report before, which is a page answering its own resize; slower equal growth is real content. A binding update (`notifyBindingUpdated`) resets it in the console and the shell, so a live artifact can grow to fit new data. New content mounts a fresh component (a new `key`). `htmlCardFrame` stays lazy-loaded, and the live HTML chunks are checked by `npm run ui:budget`.
- **Sandbox origin**: `ui/src/redesign/artifacts/sandbox/sandboxOrigin.tsx`. One `useSandboxOrigin()` and one context with two providers: `ChatSandboxProvider` (the public chat page, origins from its API) and `ConsoleSandboxProvider` (console pages with chat cards). Without a provider the hook uses the console's Host health. `setSandboxOriginForTests` overrides it in tests.
- **Renderer registries**: ui parts register in `ui/src/chat/parts/registry.tsx` (`registerUiPart`). Formats register in `ui/src/chat/parts/formatRegistry.tsx` (`registerFormatRenderer`); `formats.tsx` registers the built-in `live.declarative`, `live.html` and `static.markdown`, and both the card body (`cardPart.tsx`) and the artifact view (`ArtifactView.tsx`) render through it.

## The conformance suite

`tests/genui.conformance.test.ts` runs one table of cases (valid and invalid cards per kind, kind not granted, display-only rules, size caps, the per-reply cap, title fallback, `save_card`, and the same `publish_artifact` payload for a stage and an agent) against every surface, through the real tool objects. It exists so that callers cannot drift apart again: a rule changed in one place must hold on every surface. It must pass on every change, and a new surface is added to it.
