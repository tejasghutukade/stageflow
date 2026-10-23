# 16: Console foundation: nav, routes, shared UI modules, Evals list, empty state

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 13

## Why this story exists

Every other UI story needs the nav item, routes, shared formatting, and the page frame. The Evals list is also the first screen the owner sees and the one that proves the stack end to end.

## Read first

- [ui-map.md](../../specs/evals-ui-map.md): "Ground rules for all UI stories", "Routes", and screen 1 (list and empty state).
- Wonder artboards `one` (list) and `ict` (empty state). Open them with the Wonder tools (page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd`): `get_design_context`, then `take_screenshot` for each. Use the designs for layout, copy and states only.
- `ui/AGENTS.md`, `ui/src/components/COMPONENT-MAP.md`, `ui/src/redesign/shell/README.md`.
- The Triggers implementation as the template: `ui/src/pages/TriggersPage.tsx`, `ui/src/redesign/triggers/` (`TriggersRedesign.tsx`, `triggerListModel.ts` + test, `TriggerListRow.tsx`), `ui/src/routes.ts` (+ `routes.test.ts`), `ui/src/routeNav.ts` (+ test), `ui/src/App.tsx`, `ui/src/redesign/shell/navConfig.ts` (+ `navConfig.test.ts`), `ui/src/redesign/CommandPalette.tsx` and `ui/src/redesign/palette/`.
- The API client functions and types added by story 13 in `ui/src/api/`.

## Decisions already made (do not revisit)

Routes, nav placement (Build group after Catalog, `LuFlaskConical`), list columns, status words, banner rules, filter tabs, empty state content, engine banner, and formatting rules are in ui-map.md. The list's status, banner, trend and footer come from the API as given; the UI computes nothing statistical. Only the redesign version is built. Pure logic goes in `*.ts` files with `vitest` tests; components stay thin.

## What to build

1. **Routes:** extend `ui/src/routes.ts` with the route names and builders for every route in ui-map.md's table (`evals`, `evalNew`, `evalDetail`, `evalEdit`, `evalRun`, `evalCase`, `evalCompare`, `datasets`, `datasetDetail`) plus parsing; update `routeNav.ts` so the Evals nav item is active for all of them; tests for parse/build round-trips and nav activation.
2. **Nav and palette:** add the Evals item to `navConfig.ts` and tests; register "Evals", "New eval", "Datasets" in the command palette the same way other pages do.
3. **`ui/src/redesign/evals/format.ts`** (+ test): the formatters in ui-map.md's rules (percent, score, cost, duration, tokens, points, relative time via the existing helper in `ui/src/catalogJoin.ts` or wherever other pages get it).
4. **`ui/src/redesign/evals/evalListModel.ts`** (+ test): pure view model from the API list response: filter tabs and counts, search filtering, row labels, status label/tone mapping, delta text, trend dots, the saturated guidance line, the footer text, keyboard selection helpers.
5. **`EvalsRedesign.tsx`** (+ small row/banner components) implementing screen 1: header buttons, regression banner, filter tabs (Agents is a disabled "soon" tab), search, table, status, guidance line, footer, keyboard navigation (`↑ ↓ Enter`), invalid-eval rows ("Needs fixing"), error and loading states, the **engine banner** (from `GET /api/eval-engine`), the **empty state** with **Try the sample eval** (`POST /api/evals/sample`; on `SAMPLE_EXISTS` just open the existing sample eval) and **Create your own**.
6. **Mounting:** `App.tsx` renders the page for `route.name === "evals"`; every other eval route renders a temporary "Coming soon" placeholder until its story lands (a single shared placeholder component, so later stories replace it route by route).
7. Run `npm run ui:build` to confirm the bundle builds.

## Acceptance

- [ ] `#/evals` shows the list for a fixture API response with four evals in the four non-empty states (passing, saturated, regressed, never run) matching the artboard's structure (screenshot compared by eye against `one`).
- [ ] The banner appears only when an eval is `regressed` and links to Compare with the right run numbers.
- [ ] Filter tabs and counts, search and keyboard navigation work; opening a row goes to `#/evals/<id>`.
- [ ] The empty state appears when the list is empty; **Try the sample eval** calls the sample endpoint and navigates; **Create your own** goes to `#/evals/new`.
- [ ] The engine banner appears when the engine is not installed or Node is too old, with the copyable command.
- [ ] Route parse/build tests cover every route and its query forms; nav activation tests cover every eval route.
- [ ] Formatter tests cover each rule in ui-map.md with boundary values (`$0.004`, `$0.64`, `87.5%`, `3 m 41 s`, `142k`, `+2.1 pts`, `−9.2 pts`).
- [ ] `npm run ui:test`, `npm run ui:build` and `npm run typecheck` pass; `npm test` still passes.

## Out of scope

Any other eval screen (stories 17–23). Server work.

## Open questions

_(agent fills; stop and ask the owner)_
