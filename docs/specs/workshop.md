---
status: ready-for-agent
---

# Spec: Workshop (console authoring agent + reusable operator-agent host)

## Problem Statement

Operators who want to build or evolve Stageflow workflows today either hand-author YAML, use thin New pipeline / New stage form wizards, or leave the console for an external coding agent. Stageflow’s real authoring surface — pipeline DAG wiring, stage prompts, `io` / `verify` / `on_verify_fail`, basic HITL, artifacts/envelopes, and task bindings — is easy to get wrong and hard to learn from the catalog alone. There is no in-console place to co-create a coherent pipeline + stages + task package with an agent that knows Stageflow practice, shows the workflow as an editable DAG, validates before disk write, and keeps work-in-progress safe until the operator explicitly saves.

Separately, this authoring agent should not be a one-off chat embed. Stageflow will want other console-side agents later (for example run diagnosis, catalog migration, or HITL coaching). Without a shared host interface — profiles, tools, session streaming, proposal/apply against a typed context — each new agent would re-invent chat transport, provider wiring, and patch UX.

## Solution

Add **Workshop** to the operator console: a split workspace with (1) a chat agent that explains Stageflow and proposes concrete workflow changes, and (2) an editable DAG plus inspectors for pipeline/stage fields and a first-class task panel. All edits land in a **virtual draft package** (in-memory models for pipeline, referenced stages, and optional task). Chat proposals appear as reviewable diffs with DAG highlights and apply only after Accept, unless the operator enables auto-apply for the draft. Disk is touched only on Save / Save As. Validation uses the existing catalog load/validate stack; Save is blocked when invalid unless the operator explicitly overrides. After Save, the operator stays in Workshop with shortcuts to run (when a task is attached) or open the catalog entry.

Implement the chat side on a new **Operator Agent Host** (name may vary in code) that is deliberately separate from stage-execution `AgentPort`. The host is profile-driven: a profile supplies playbook, toolset, and context adapters. **Workshop Author** is the first profile. Future console agents reuse the same host, session/streaming contract, provider settings, and proposal/apply patterns with different profiles and tools.

## Live Author protocol (supersession)

**Session-settled for the live Workshop Author slice:** The propose→Accept gate described elsewhere in this spec (staged chat proposals that apply only after Accept, plus auto-apply as an alternate gate) is **superseded for live Author chat**. Create/edit tools **mutate the in-memory draft immediately**; the studio reflects changes before Accept. Accept is confirmation UX; Reject **soft-undos** that mutation when the draft fingerprint is unchanged since apply (otherwise fail closed — operator asks the agent to undo). Soft undo does **not** reverse a successful disk `save`. Agents still clarify intent until ready, then create (**clarify-then-create**). Durable chat sessions live under `$STAGEFLOW_HOME/workshop/sessions/` as transcript + agent session id (+ title, timestamps) only — the draft package is **not** stored in the session blob (draft stays client-/Workshop-owned; autosave WIP slots remain a separate contract). Broader Workshop product outside this slice (catalog Open, DAG rewire, disk-change banner, pipeline↔session linking) is unchanged by this note.

## User Stories

1. As an operator, I want a Workshop entry in the app rail, so that I can open the authoring workspace without hunting through catalog pages.
2. As an operator viewing a pipeline detail page, I want “Open in Workshop”, so that I can evolve that pipeline without re-selecting it.
3. As an operator viewing a task detail page, I want “Open in Workshop”, so that I can open the bound pipeline package and optionally keep that task attached.
4. As an operator, I want to start a New workshop draft as an empty scaffold, so that I am not steered into a fake sample domain.
5. As an operator starting New, I want the chat to greet me and ask what we are building, so that the agent can seed structure from my intent.
6. As an operator, I want to Open an existing pipeline into Workshop and load the pipeline plus all referenced stage files into a virtual draft, so that I can edit the full stage graph coherently.
7. As an operator who opened a pipeline, I want the task panel empty until I attach or create a task, so that pipeline-only editing stays valid.
8. As an operator, I want to attach an existing task to the draft, so that Save can produce a runnable package and Run is available afterward.
9. As an operator, I want the agent to propose creating or filling a task (same Accept flow as stages), so that I am not forced to leave chat to finish a runnable workflow.
10. As an operator, I want to edit task fields in a first-class task panel, so that task authoring is not buried in chat.
11. As an operator, I want a split view with chat on one side and an editable DAG on the other, so that I can see workflow shape while conversing.
12. As an operator, I want the DAG to feel like the run spatial map (familiar Stageflow graph language), so that I am not learning a second visualization.
13. As an operator, I want to add, remove, and rewire stages on the DAG, so that I can reshape the pipeline visually.
14. As an operator, I want to select a stage and edit every core field in an inspector (prompts, `io`, `verify`, `on_verify_fail`, basic HITL / `ask_operator`, artifact/envelope-related fields in core scope), so that I am not limited to chat for details.
15. As an operator, I want to edit pipeline-level fields in an inspector, so that entry/routing and package metadata are editable without raw YAML.
16. As an operator, I want my inspector and DAG edits applied immediately to the virtual draft, so that the canvas is always live truth for manual work.
17. As an operator, I want chat-proposed changes staged as a reviewable summary and per-artifact diff, so that I can see what the agent intends before it mutates my draft.
18. As an operator, I want affected DAG nodes highlighted while a chat proposal is pending, so that I understand structural impact at a glance.
19. As an operator, I want a single Accept to apply a pending chat proposal to the draft, so that approval is one deliberate step.
20. As an operator, I want to Reject a pending chat proposal, so that the draft stays unchanged.
21. As an operator, I want an “Auto-apply chat edits” toggle, so that I can skip per-proposal Accept when I trust the agent for this draft.
22. As an operator, I want natural-language requests like “just apply changes” to flip the same auto-apply setting, so that I can control it conversationally.
23. As an operator, I want auto-apply to affect only the virtual draft, never disk, so that Save remains an explicit publish step.
24. As an operator, I want the agent to always read the current draft before proposing, so that proposals account for my live UI edits.
25. As an operator, I want to Save and overwrite the known package paths when editing an opened or previously saved draft, so that iteration is fast.
26. As an operator, I want Save As to fork the package to a new destination, so that I can variant a workflow without clobbering the original.
27. As an operator on a New draft, I want the first Save to collect a destination (and then behave like overwrite thereafter), so that untitled work can land in the catalog.
28. As an operator, I want Save blocked when validation fails, so that I do not accidentally publish a broken package.
29. As an operator, I want an explicit “Save invalid anyway” override, so that I can still persist intentional work-in-progress YAML when I choose to.
30. As an operator, I want a Validate control in the Workshop toolbar, so that I can check the draft without asking the LLM.
31. As an operator, I want validation errors shown in a panel, so that I can scan problems independently of chat.
32. As an operator, I want to ask the agent to fix validation errors, so that explain/repair stays in the same thread.
33. As an operator, I want the agent itself to be able to run validation against the draft and iterate, so that authoring and checking form a closed loop.
34. As an operator after a successful Save, I want to stay in Workshop, so that I can keep refining.
35. As an operator after Save, I want a shortcut to Run this workflow when a task is attached, so that I can enter the existing New Run flow without re-picking paths.
36. As an operator after Save, I want a shortcut to open the saved package in the catalog, so that I can inspect listing/detail pages.
37. As an operator, I want unsaved drafts autosaved under Stageflow home / workspace `.stageflow`, so that refresh or leaving the page does not silently destroy work.
38. As an operator, I want autosave to include the chat transcript and draft models together, so that resume restores the same thread and package.
39. As an operator, I want one WIP draft per pipeline path (plus one untitled slot for New), so that reopening a pipeline restores that pipeline’s workshop state without a full drafts manager.
40. As an operator, I want autosave cleared after successful Save or discard, so that stale WIPs do not linger forever.
41. As an operator, if catalog files change on disk while Workshop is open, I want a warning with Reload vs Keep workshop draft, so that IDE edits and Workshop do not silently diverge.
42. As an operator, I want Workshop chat to use the same provider stack as stage runs, so that I do not manage a second auth system.
43. As an operator, I want a Settings default for “Workshop model” plus an in-session model override, so that authoring can use a sensible default without picking every time.
44. As an operator, I want the agent to teach Stageflow best practices (contracts, verify, HITL, envelopes) while building, so that I learn the system as I go.
45. As an operator, I want the agent’s expertise to come from a baked playbook plus live docs/examples retrieval, so that answers stay on-rails and current.
46. As an operator, I want New pipeline / New stage wizards to remain available, so that quick simple creates stay one form away.
47. As an operator, I want Workshop v1 to focus on the core path (linear/DAG stages, prompts, `io` / `verify` / `on_verify_fail`, basic HITL, artifacts/envelopes), so that the product ships without boiling the ocean.
48. As an operator, I want the agent to still be able to explain advanced topics (clone-chain, feedback loops, stage MCP, complex recovery) from docs without first-class editors, so that I am not lied to about the wider system.
49. As a developer, I want Workshop chat built on a reusable Operator Agent Host, so that later console agents do not fork a second chat stack.
50. As a developer, I want agent behavior packaged as profiles (id, playbook, tools, context adapters), so that a new agent is mostly a new profile rather than a new product shell.
51. As a developer, I want the host clearly separated from stage-execution `AgentPort`, so that console chat sessions are not confused with pipeline stage sessions.
52. As a developer, I want proposal/apply to be a host-level pattern (patches against a typed context), so that future agents can reuse Accept / auto-apply UX.
53. As a developer, I want Workshop’s virtual draft to be the context document for the Workshop profile’s tools, so that tools mutate one shared package model.
54. As a developer, I want validate and save to go through the existing catalog load/validate/write seam, so that Workshop cannot invent a second source of truth for YAML correctness.
55. As a developer, I want Save overwrite / Save As to extend today’s create-only catalog writes rather than bypass validation, so that disk writes remain validate-then-write.
56. As a developer, I want the editable DAG to be a projection/adapter from the draft DAG (familiar track/layout types), so that visualization is not a second workflow model.
57. As an operator, I want discard of a WIP draft to be explicit and confirmed when dirty, so that I do not lose work accidentally.
58. As an operator, I want pending chat proposals cleared or rebased sensibly if I edit the draft in the UI before Accept, so that Accept cannot apply a stale patch blindly (reject or recompute; never clobber without notice).
59. As a platform owner, I want future agents (for example run debugger or catalog migrator) to plug into the same host with different tools and playbooks, so that Stageflow can grow an agent family inside the console.
60. As an operator using Workshop, I want streaming chat responses, so that long authoring turns feel responsive.
61. As an operator, I want clear empty states on New (blank DAG, empty task, greeting in chat), so that the workshop’s purpose is obvious immediately.
62. As an operator, I want package file paths / ids visible when saving, so that I know what will be written into the catalog.
63. As a developer writing tests, I want the Operator Agent Host and draft validate/save logic testable without rendering the full React workshop page, so that core behavior stays at a high seam.
64. As an operator, I want Workshop naming and navigation to say “Workshop” (not only “chat”), so that the DAG and inspectors are first-class, not an afterthought to a chatbot.

## Implementation Decisions

### Seams (agreed)

- **Primary seam:** existing catalog **load → validate → write** stack (`loadPipelineValidated` / validate pipeline+stages+task, and create/update writers used by catalog APIs). Workshop must not introduce a parallel validator.
- Virtual draft validation = in-memory / inline definitions fed through that validate path (temp materialization allowed if the stack requires paths).
- Save / Save As = validate-then-write through the same stack; overwrite for known paths is a required extension beyond create-only POSTs.
- Editable DAG = adapter from draft DAG into existing track projection / spatial layout types; presentation only.
- Chat, autosave, proposal UX, and Workshop model settings sit above the catalog seam.

### Operator Agent Host (reusable substrate)

- Introduce a **console Operator Agent Host** distinct from stage-execution **`AgentPort`** (`openStage` / `runStage`). Do not overload `AgentPort` for Workshop chat.
- Host responsibilities: open/close sessions, stream assistant/tool events to the UI, bind a **profile**, bind a **context handle**, invoke tools, and emit **structured proposals** (patches) for optional human Accept.
- **Profile** (data + behavior registration), at minimum:
  - stable `id` and human title
  - system playbook (baked Stageflow authoring guidance for Workshop; other agents bring their own)
  - tool declarations and handlers
  - optional docs/examples retrieval hooks
  - context adapter: how to read/serialize the active context for the model/tools
- **Workshop Author** is profile zero. Future agents register additional profiles without forking the host.
- **Proposal protocol (host-level):** tools or model output produce a typed patch against the context (for Workshop: draft package models). UI shows summary + diff + DAG highlights. Accept applies via context adapter; Reject drops. Auto-apply is a session/draft flag honored by the host/UI the same way for every profile that emits proposals.
- Provider/model resolution for operator agents reuses Stageflow’s configured provider stack; Settings gains a default **Workshop model** (and later other agent defaults can follow the same settings pattern). Session override is allowed in Workshop chrome.
- Streaming transport may be HTTP/SSE or an equivalent console API; the important contract is host session events, not a particular wire format. Prefer one session API shape reusable by future agent UIs.
- Playbook content for Workshop should be derived from / kept aligned with existing harness authoring skills (`stageflow-author` and related references) plus live read of public docs/examples when tools request them.
- Fake/test double for the host is required so catalog and draft tests do not need a live LLM.

### Workshop draft package

- In-memory models for pipeline, stage map, optional task — not “string YAML as source of truth” while editing. YAML is generated at Save (and for validate materialization as needed).
- Author-facing fields use catalog dialect concepts (`io`, `verify`, `on_verify_fail`, etc.); compilation to runtime IR remains the existing config path’s job on validate/load.
- Open is **pipeline-centric**: resolve pipeline + referenced stages; task optional.
- New = empty scaffold + chat greeting; no hard-coded sample stages.
- Autosave store: Stageflow home and/or workspace `.stageflow` (not browser-only), keyed by pipeline path or untitled slot; includes transcript + models + auto-apply flag + model override.
- On-disk change detection while open: banner with Reload (discard local) vs Keep workshop draft.

### Workshop UI

- Route/mode in the existing operator console (same chrome), labeled **Workshop**.
- Layout: chat | editable DAG + inspector; task panel first-class.
- **Chat island (presentation):** Workshop chat uses a stock assistant-ui Thread island (`WorkshopChatIsland` + registry Thread under `.aui-root`) styled with `@assistant-ui/styles`. Astryx / `console.css` remain for rail, map, and page chrome outside the island. The **Operator Agent Host** remains the brain (`useLocalRuntime` + `ChatModelAdapter` → Workshop chat HTTP); soft-undo / immediate draft mutate is unchanged (see Live Author protocol above). Approach recorded in `docs/plans/2026-09-29-1948-feat-workshop-assistant-ui-richness-plan.md` (supersedes `.scratch/workshop/assistant-ui-plan.md` primitives+Astryx-only / `ExternalStoreRuntime` preference for the chat pane).
- Core editable surface area only in v1 inspectors; advanced features explain-only via agent/docs.
- Validate toolbar button shares the same validate function as the agent tool.
- Keep existing New pipeline / New stage wizards.

### Catalog write API

- Extend server/catalog write capabilities for overwrite and Save As (multi-file package: pipeline + stages + optional task) after validation.
- First Save on untitled collects destination consistent with catalog roots / project_root patterns already used by create APIs.
- “Save invalid anyway” skips the block but should still be an explicit operator action and auditable in UI copy.

### Relationship to existing systems

- Do not replace harness skills used outside the console; Workshop is an in-console product surface. Skills remain a playbook/source input.
- Do not implement session-capture→pipeline inside Workshop v1.
- Run shortcut after Save deep-links into existing New Run flow with pipeline/task paths filled when available.

## Testing Decisions

- Good tests assert **external behavior at the agreed seam**: given a draft package (or inline definition), validate findings match catalog rules; save writes expected files only after validate (or after explicit invalid override); proposal Accept mutates draft models as specified; autosave round-trips transcript+models. Do not assert on React markup or LLM token text.
- **Primary tested modules:** draft package model + validate/save facades over catalog load/validate/write; Operator Agent Host session/proposal apply with a fake model/tool backend; projection adapter from draft DAG to track layout inputs.
- **Prior art:** catalog create/validate/load tests, server HTTP create/settings/providers tests, track projection and spatial layout tests, UI API client tests for providers/settings. Prefer extending those styles over new frameworks.
- UI page composition (Workshop page shell) stays thin; heavy logic stays in testable host/draft modules. Full browser E2E is not required for v1 acceptance of this spec.
- Fake Operator Agent Host / profile tools cover: propose patch → Accept/Reject/auto-apply; validate tool returns catalog-shaped errors; docs retrieval can be stubbed.

## Out of Scope

- Trial or dry **runs inside** Workshop.
- First-class editors for **clone-chain, feedback loops, stage MCP, complex recovery**.
- **Raw YAML IDE** tabs (models + inspector only).
- Replacing **New pipeline / New stage** wizards.
- Multi-draft manager UI / cloud sync of drafts.
- Turning an arbitrary **past run transcript** into a pipeline inside Workshop (remains harness session-capture).
- Overloading or redesigning stage-execution **`AgentPort`** to serve console chat.
- Building the second/third operator-agent profiles beyond Workshop Author (host must allow them; implementing them is out of scope).
- Live continuous validation while typing.
- WebSocket-only requirement if SSE/HTTP streaming already fits the console.

## Further Notes

- Locked product brief originated from a design grill: explain+author, virtual draft, Workshop split UI, core-path v1, reusable agent host added before spec freeze.
- Domain vocabulary: pipeline, stage, task, catalog, `stageflow.yaml`, envelope, `io`, `verify`, `on_verify_fail`, HITL / `ask_operator`, `AgentPort` (stage execution only), Operator Agent Host / profile (console agents).
- This spec is the parent record. Delivery tickets (vertical slices) live under `.scratch/workshop/issues/` (local tracker; gitignored). Earlier horizontal notes under `docs/tickets/workshop/` are superseded.
- Publish mirror: GitHub Issues when available; in-repo canonical copy is this file with `status: ready-for-agent`.
