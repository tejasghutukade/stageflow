# Shell primitives

Shared layout for the redesign console. Components use Tailwind utilities and `var(--sf-*)` tokens.

## `AppShell`

Props: `rail` (sidebar node), `children` (page content).

Full-viewport grid: `232px` rail + scrolling main (`h-screen`, `grid-cols-[232px_1fr]`).

## `AppRail`

Props: `activeId`, `onNavigate`, `waitingCount`, `inFlightCount`, `health`, `workspaceName`, `workspaceSubtitle`, `heldWaitingCount`, `onOpenPalette`.

Grouped nav, capacity meter, compact provider row, pins, workspace switcher, search, start run.

## `PageHeader`

Props: `title`, `subtitle?`, `actions?`, `titleAddon?`, `variant?: "bar" | "inbox"`, `className?`.

`bar`: standard page title row (`h-14`, border). `inbox`: inbox zero title row with optional addon pill.

## `FilterTabs`

Props: `tabs` (`{ id, label, count? }[]`), `activeId`, `onChange`, `variant?: "bar" | "underline" | "queue"`.

`bar`: pill tabs in a filter bar. `underline`: bottom-border tabs (inbox zero). `queue`: inbox queue tabs (amber active on Needs you).

## `DataTable` / `DataTableRow`

`DataTable`: `children`, optional `className`.

`DataTableRow`: `selected?`, `needs?`, `onClick?`, `variant?: "table" | "gate"`, `children`.

`gate`: inbox queue cards. `table`: full-width list rows for runs/tasks/catalog.

## `Inspector`

Props: `title?`, `children`, `className?`.

Right-hand `384px` panel (`w-96`), border and scroll body.
