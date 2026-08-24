# AGENTS.md

Project-specific guidance for AI coding agents.

## Operator console UX

When changing operator-console layout, navigation, HITL reply surfaces, run/stage chrome, triage home, theme, or status presentation — read `docs/ideation/2026-08-16-ui-app/UX-DECISIONS.md` first (shell law, IA, HITL kinds, copy).

When adding or wiring UI modules for that console — use `ui/src/components/COMPONENT-MAP.md` and prefer skeletons under `ui/src/components/` over inventing parallel patterns.

When scoping backend/API or screen work to match the prototype — read `docs/ideation/2026-08-16-ui-app/BUILD-GAP.md` (gap + phased order).

Static HTML under `docs/ideation/2026-08-16-ui-app/` is a design snapshot, not production.

<!-- ASTRYX:START -->
Astryx v0.4.0 · 90+ components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   90+ components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

## Chrome exception (Phase 6)

The operator-console chrome primitives — rail, page-head, zone, block, run-row, fail-row, rrow, pick, theme-pick, gate, track-mini, mini, filters/tab, topbar, capacity, setting, table, drawer, kv — are ported from the finalized HTML prototype (`docs/ideation/2026-08-16-ui-app/`) as CSS classes in `ui/src/console.css`, using Astryx design tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`, `var(--font-size-*)`, `var(--shadow-*)`). Native HTML elements (`<div>`, `<span>`, `<nav>`, `<section>`, `<table>`, `<a>`, `<button>`, `<aside>`, `<dl>`) are allowed for those primitives. This overrides the "No `<div>`" and "don't hand-roll CSS" Astryx rules for chrome surfaces.

Astryx atoms remain where they already work: `Markdown`, `CodeBlock`, `Token`, `Collapsible`, `Theme`, and `Banner` (as last resort). Do not replace working Astryx content components with hand-rolled equivalents.
