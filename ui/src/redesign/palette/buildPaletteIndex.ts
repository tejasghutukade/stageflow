import type { PipelineListing, RunSummary, TaskListing } from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import { runShortId } from "../../catalogJoin";
import { runDisplayStatus } from "../../status/runStatus";
import { runStatusPillLabel } from "../statusSignal";
import type {
  PaletteActionContext,
  PaletteGroup,
  PaletteItem,
  PaletteNavDef,
} from "./types";

const NAV_ITEMS: PaletteNavDef[] = [
  { id: "inbox", label: "Inbox", path: "/inbox" },
  { id: "runs", label: "Runs", path: "/runs" },
  { id: "pipelines", label: "Pipelines", path: "/pipelines" },
  { id: "workshop", label: "Workshop", path: "/workshop" },
  { id: "tasks", label: "Tasks", path: "/tasks" },
  { id: "catalog", label: "Catalog", path: "/catalog?tab=stages" },
  { id: "triggers", label: "Triggers", path: "/triggers" },
  { id: "settings", label: "Settings", path: "/settings" },
];

function normQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchScore(haystack: string, query: string): number {
  if (!query) return 1;
  const h = haystack.toLowerCase();
  if (h === query) return 100;
  if (h.startsWith(query)) return 80;
  if (h.includes(query)) return 50;
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => h.includes(p))) return 40;
  return 0;
}

function paletteRunRef(runId: string): string {
  const short = runShortId(runId);
  return short.startsWith("run_") ? short : `run_${short}`;
}

function staticActions(
  ctx: PaletteActionContext,
  runs: RunSummary[],
): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      id: "action-start-run",
      group: "actions",
      label: "Start a run",
      context: "New task + pipeline",
      keywords: "start run new",
      score: 90,
      run: () => ctx.onStartRun(),
    },
  ];
  if (ctx.firstWaitingRunId) {
    const waitingRun = runs.find((r) => r.run_id === ctx.firstWaitingRunId);
    const taskPart = waitingRun ? runTaskLabel(waitingRun) : "";
    const gatePart = waitingRun?.waiting_stage_id ?? "";
    const context = [paletteRunRef(ctx.firstWaitingRunId), taskPart || gatePart]
      .filter(Boolean)
      .join(" · ");
    items.push({
      id: "action-answer-gate",
      group: "actions",
      label: "Answer next gate",
      context,
      keywords: "answer gate inbox waiting",
      score: 95,
      run: () => ctx.onNavigate(`/runs/${encodeURIComponent(ctx.firstWaitingRunId!)}`),
    });
  }
  if (ctx.firstBrokenRunId) {
    const brokenRun = runs.find((r) => r.run_id === ctx.firstBrokenRunId);
    const taskPart = brokenRun ? runTaskLabel(brokenRun) : "";
    const stagePart = brokenRun?.failed_stage_id ?? "";
    const context = [
      paletteRunRef(ctx.firstBrokenRunId),
      taskPart || stagePart,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push({
      id: "action-retry-failed",
      group: "actions",
      label: "Retry failed stage",
      context,
      keywords: "retry failed broken",
      score: 70,
      run: () => {
        if (ctx.onRetryBroken) {
          ctx.onRetryBroken(ctx.firstBrokenRunId!);
        } else {
          ctx.onNavigate(`/runs/${encodeURIComponent(ctx.firstBrokenRunId!)}`);
        }
      },
    });
  }
  return items;
}

function runRows(runs: RunSummary[], query: string, onNavigate: (path: string) => void): PaletteItem[] {
  const rows: PaletteItem[] = [];
  for (const run of runs) {
    const label = runTaskLabel(run);
    const statusLabel = runStatusPillLabel(runDisplayStatus(run));
    const blob = [
      run.run_id,
      runShortId(run.run_id),
      paletteRunRef(run.run_id),
      run.task_id,
      run.pipeline_id,
      run.waiting_summary ?? "",
      label,
      statusLabel,
    ].join(" ");
    const score = matchScore(blob, query);
    if (score <= 0 && query) continue;
    rows.push({
      id: `run-${run.run_id}`,
      group: "runs",
      label,
      context: `${run.pipeline_id} · ${statusLabel}`,
      keywords: blob,
      score: score || (query ? 0 : 10),
      run: () => onNavigate(`/runs/${encodeURIComponent(run.run_id)}`),
    });
  }
  return rows;
}

function pipelineRows(
  pipelines: PipelineListing[],
  query: string,
  onNavigate: (path: string) => void,
): PaletteItem[] {
  const rows: PaletteItem[] = [];
  for (const p of pipelines) {
    const blob = [p.id, p.path, ...p.stages.map((s) => s.id)].join(" ");
    const score = matchScore(blob, query);
    if (score <= 0 && query) continue;
    rows.push({
      id: `pipeline-${p.path}`,
      group: "pipelines",
      label: p.id,
      context: `${p.stages.length} stages`,
      keywords: blob,
      score: score || (query ? 0 : 8),
      run: () => onNavigate(`/pipelines/${encodeURIComponent(p.id)}`),
    });
  }
  return rows;
}

function navRows(query: string, onNavigate: (path: string) => void): PaletteItem[] {
  return NAV_ITEMS.map((nav) => {
    const score = matchScore(`${nav.label} ${nav.id}`, query);
    return {
      id: `nav-${nav.id}`,
      group: "navigation" as PaletteGroup,
      label: nav.label,
      context: nav.path,
      keywords: nav.label,
      score: score || (query ? 0 : 5),
      run: () => onNavigate(nav.path),
    };
  }).filter((row) => row.score > 0 || !query);
}

export type BuildPaletteIndexInput = {
  snapshot: CatalogSnapshot;
  tasks: TaskListing[];
  pipelines: PipelineListing[];
  query: string;
  ctx: PaletteActionContext;
};

export function buildPaletteIndex(input: BuildPaletteIndexInput): PaletteItem[] {
  const query = normQuery(input.query);
  const actions = staticActions(input.ctx, input.snapshot.runs)
    .map((a) => ({
      ...a,
      score: query ? matchScore(`${a.label} ${a.keywords ?? ""}`, query) : a.score,
    }))
    .filter((a) => a.score > 0 || !query);

  const runs = runRows(input.snapshot.runs.slice(0, 80), query, input.ctx.onNavigate);
  const pipelines = pipelineRows(input.pipelines, query, input.ctx.onNavigate);
  const navigation = navRows(query, input.ctx.onNavigate);

  const all = [...actions, ...runs, ...pipelines, ...navigation];
  all.sort((a, b) => b.score - a.score);
  if (!query) {
    const groupOrder: PaletteGroup[] = ["actions", "navigation", "runs", "pipelines"];
    const byGroup = (g: PaletteGroup) => all.filter((i) => i.group === g);
    return groupOrder.flatMap((g) => byGroup(g).slice(0, g === "actions" ? 6 : g === "navigation" ? 8 : 5));
  }
  return all.filter((i) => i.score > 0).slice(0, 40);
}

export function groupPaletteItems(items: PaletteItem[]): { group: PaletteGroup; items: PaletteItem[] }[] {
  const order: PaletteGroup[] = ["actions", "runs", "pipelines", "navigation"];
  return order
    .map((group) => ({
      group,
      items: items.filter((i) => i.group === group),
    }))
    .filter((g) => g.items.length > 0);
}
