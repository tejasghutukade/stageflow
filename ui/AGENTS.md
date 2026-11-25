# AGENTS.md

Project-specific guidance for AI coding agents.

## Operator console UX

When changing operator-console layout, navigation, HITL reply surfaces, run/stage chrome, triage home, theme, or status presentation — follow the shell, information architecture, HITL kinds, and copy already in this console.

When adding or wiring UI modules for that console — for code outside `ui/src/redesign/`, use `ui/src/components/COMPONENT-MAP.md` and prefer skeletons under `ui/src/components/` over inventing parallel patterns. For redesign screens, copy a sibling screen under `ui/src/redesign/`.

When scoping backend/API or screen work — match the screens and components already in `ui/src/`. Production UI is that tree, and its shell is `ui/src/redesign/`.

## Design system: the redesign, not Astryx

The console shell is the **redesign** in `ui/src/redesign/` (always on: `flag.ts` sets `data-redesign="on"`; commit f3a5f514 made it the only shell). It is **not** built on Astryx. Do not start new UI with Astryx, and do not run `astryx build` / `astryx template` for new screens.

What the redesign uses:

- **Tokens:** `--sf-*` CSS variables in `redesign/tokens.css`, scoped to `html[data-redesign="on"]` (ground, panel, raised, text-1/2/3, hairline, needs/running/ok/fail/queued/skipped, `--sf-font-ui`, `--sf-font-mono`). Read that file before choosing a color. Reuse the status tokens for status; do not invent new hues.
- **Styling:** Tailwind v4 utilities (`redesign/tailwind.css`, layered `theme, base, sf-components, components, utilities`) plus `sf-*` classes in `@layer sf-components` (`.sf-pill`, `.sf-mono`, ...). Native `<div>`, `<span>`, `<button>` are normal here.
- **Type and icons:** Geist and Geist Mono; icons from `react-icons/lu`.
- **Shell primitives:** `redesign/shell/` (`AppShell`, `AppRail`, `PageHeader`, `FilterTabs`, `DataTable`/`DataTableRow`, `Inspector`). Read `redesign/shell/README.md`. `PageHeader` owns the bar chrome; do not hand-copy it.
- **Screens:** one folder per area under `redesign/` (`runs`, `inbox`, `agents`, `evals`, `functions`, `workshop`, ...). Match a sibling screen before adding a new pattern. Raw hex does occur in redesign code today; prefer an `--sf-*` token and do not add new hex.

Astryx is legacy and still partly present. Measured 2026-11-24: 13 of 310 `.tsx` files in `ui/src` import `@astryxdesign/*`; 3 of the 250 in `redesign/` do (`workshop/chat/WorkshopTranscript.tsx`, `memories/MemoryDetailParts.tsx`, `artifacts/renderers/StaticPreview.tsx`, which uses Astryx `Markdown` because the redesign has no markdown renderer yet; replace it when one exists). The rest are older pages and components (`App.tsx`, `StatusLabel.tsx`, `pages/RunDetailPage.tsx`, `liveView/LiveView.tsx`, `workshop/WorkshopChatIsland.tsx`, and in `components/`: `ArtifactReader`, `LogPanel`, `EnvelopeFields`, `FeedbackLoopPanel`, `VerificationHistory`). `main.tsx` still imports the Astryx CSS, and `tokens.css` remaps a few Astryx `--color-*` variables to `--sf-*` so those leftovers follow the redesign.

Rules for Astryx leftovers:

- Editing a file that already uses Astryx: keep its Astryx components (`Markdown`, `CodeBlock`, `Token`, `Collapsible`, `Banner`, chat components) unless the task is to migrate it. Do not hand-roll replacements for working ones.
- New screens and new components: redesign tokens and Tailwind, no new Astryx imports.
- Before assuming how something is styled, grep the folder you are editing. The directory, not this file's history, is the truth. If you find this section is out of date, update it in the same change.

Check first, every time: is the screen you are changing under `ui/src/redesign/`? `ui/src/components/` and `ui/src/pages/` hold older code, and `components/COMPONENT-MAP.md` describes that older tree. Use it for those files only, not as the pattern for new work.


## Chrome exception (Phase 6, legacy)

Older run-page chrome primitives (rail, page-head, zone, block, run-row, track-mini, drawer, kv, graph-view, run-page workspace, and similar) are CSS classes in `ui/src/console.css`, written against Astryx tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`). Native HTML elements are allowed there. This applies only to code that still uses `console.css`; new chrome belongs in `redesign/` with `--sf-*` tokens.

`npm run ui:dev` proxies `/api` to `127.0.0.1:3847` and rewrites `Origin` to that host. The Host rejects an Origin whose port does not match `Host`. The dev server needs a running Host and its control token.
