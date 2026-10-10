import type { WorkshopChatProposalPayload } from "../../../api";
import type { WorkshopToolActivityRow } from "../../../workshop/workshopChatView";
import { artifactDiff, sumTotals, type ArtifactDiff, type DiffTotals } from "./lineDiff";

export type ProposalArtifact = WorkshopChatProposalPayload["artifacts"][number];

export type ChangeFileRow = {
  path: string;
  kind: ProposalArtifact["kind"];
  diff: ArtifactDiff;
};

export function changeFileRows(
  artifacts: readonly ProposalArtifact[] | undefined,
): ChangeFileRow[] {
  return (artifacts ?? []).map((artifact) => ({
    path: artifact.path,
    kind: artifact.kind,
    diff: artifactDiff(artifact),
  }));
}

export function changeTotals(rows: readonly ChangeFileRow[]): DiffTotals {
  return sumTotals(rows.map((row) => row.diff.totals));
}

export type ChangeSummaryItem = { op: "+" | "~" | "−"; label: string };

export type ProposalChangeSummary = {
  items: ChangeSummaryItem[];
  stageCount: number;
  fileCount: number;
  line: string;
  countLine: string;
};

const OP_FOR_KIND: Record<ProposalArtifact["kind"], ChangeSummaryItem["op"]> = {
  added: "+",
  modified: "~",
  removed: "−",
};

function isPipelinePath(path: string): boolean {
  return /\.pipeline\.ya?ml$/i.test(path);
}

function isTaskPath(path: string): boolean {
  return /\.task\.ya?ml$/i.test(path);
}

export function stageLabelFromPath(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.replace(/(\.stage)?\.(ya?ml|json)$/i, "");
}

function stageIdsOf(draft: WorkshopChatProposalPayload["baseDraft"] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const stage of draft?.pipeline?.stages ?? []) {
    if (typeof stage.id === "string" && stage.id) ids.add(stage.id);
  }
  return ids;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function proposalChangeSummary(
  proposal: Pick<
    WorkshopChatProposalPayload,
    "artifacts" | "affectedStageIds"
  > &
    Partial<Pick<WorkshopChatProposalPayload, "baseDraft" | "nextDraft">>,
): ProposalChangeSummary {
  const artifacts = proposal.artifacts ?? [];
  const items: ChangeSummaryItem[] = [];
  const stageLabels = new Set<string>();
  let task: ChangeSummaryItem | null = null;
  let pipelineTouched = false;

  for (const artifact of artifacts) {
    if (isPipelinePath(artifact.path)) {
      pipelineTouched = true;
      continue;
    }
    if (isTaskPath(artifact.path)) {
      task = { op: OP_FOR_KIND[artifact.kind], label: "task" };
      continue;
    }
    const label = stageLabelFromPath(artifact.path);
    if (stageLabels.has(label)) continue;
    stageLabels.add(label);
    items.push({ op: OP_FOR_KIND[artifact.kind], label });
  }

  const before = stageIdsOf(proposal.baseDraft);
  const after = stageIdsOf(proposal.nextDraft);
  for (const id of proposal.affectedStageIds ?? []) {
    if (stageLabels.has(id)) continue;
    stageLabels.add(id);
    const op: ChangeSummaryItem["op"] =
      after.has(id) && !before.has(id)
        ? "+"
        : before.has(id) && !after.has(id)
          ? "−"
          : "~";
    items.push({ op, label: id });
  }

  const stageCount = items.length;
  if (task) items.push(task);
  if (items.length === 0 && pipelineTouched) items.push({ op: "~", label: "pipeline" });

  return {
    items,
    stageCount,
    fileCount: artifacts.length,
    line: items.map((item) => `${item.op} ${item.label}`).join(" · "),
    countLine: `${plural(stageCount, "stage")} · ${plural(artifacts.length, "file")}`,
  };
}

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "propose_draft",
  "create_build",
  "create_pipeline",
  "edit_pipeline",
  "create_stage",
  "edit_stage",
  "create_task",
  "edit_task",
  "add_stage",
  "update_stage",
]);

export type ToolResultView =
  | { tone: "running"; label: "running" }
  | { tone: "applied"; label: "applied" }
  | { tone: "done"; label: "done" }
  | { tone: "error"; label: string };

export function toolResultView(call: Pick<WorkshopToolActivityRow, "name" | "status" | "errorMessage">): ToolResultView {
  if (call.status === "running") return { tone: "running", label: "running" };
  if (call.status === "error") {
    const message = call.errorMessage?.trim();
    return { tone: "error", label: message ? message : "error" };
  }
  if (MUTATION_TOOL_NAMES.has(call.name)) return { tone: "applied", label: "applied" };
  return { tone: "done", label: "done" };
}

export function isMutationTool(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(name);
}

export function askToChangePrefill(summary: string): string {
  const trimmed = summary.trim();
  return trimmed ? `Change to "${trimmed}": ` : "Change this: ";
}

export function modelTail(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.endsWith(":free") ? tail.slice(0, -":free".length) : tail;
}
