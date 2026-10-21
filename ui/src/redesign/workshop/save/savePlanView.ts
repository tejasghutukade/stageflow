import type {
  DraftPackagePayload,
  DraftPlanFile,
  DraftPlanResult,
  DraftValidationResult,
  ValidationFinding,
} from "../../../api";
import { findingLocation } from "../drawer/drawerModel";

export type { DraftPlanFile, DraftPlanResult };

export type SaveDialogMode = "create" | "overwrite";

export type SavePlanRow = {
  path: string;
  kind: DraftPlanFile["kind"];
  action: DraftPlanFile["action"] | null;
  added: number;
  removed: number;
  statusLabel: string | null;
  statusPill: boolean;
  muted: boolean;
  taskAttached: boolean;
  errorCount: number;
  errorLabel: string | null;
};

export type PipelineIdHint = { text: string; tone: "muted" | "warn" };

export type ValidationLine = { finding: ValidationFinding; location: string; message: string };

export type ValidationView =
  | { status: "none" }
  | { status: "failed"; title: string; errors: number; lines: ValidationLine[] }
  | { status: "passed"; title: string; warnings: number };

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

function pathMatches(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (!left || !right) return false;
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function joinPath(directory: string, rel: string): string {
  const dir = normalizePath(directory).replace(/\/+$/, "");
  const file = normalizePath(rel);
  if (!dir || dir === ".") return file;
  return `${dir}/${file}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function stageIdsForFile(filePath: string, draft: DraftPackagePayload): Set<string> {
  const ids = new Set<string>();
  for (const stage of draft.stages ?? []) {
    if (!pathMatches(filePath, stage.path)) continue;
    if (typeof stage.body.id === "string") ids.add(stage.body.id);
  }
  for (const ref of draft.pipeline.stages) {
    if (typeof ref.uses === "string" && typeof ref.id === "string" && pathMatches(filePath, ref.uses)) {
      ids.add(ref.id);
    }
  }
  return ids;
}

export function assignFindingsToFiles(
  files: Array<{ path: string; kind: DraftPlanFile["kind"] }>,
  draft: DraftPackagePayload,
  findings: ValidationFinding[],
): Map<string, ValidationFinding[]> {
  const byPath = new Map<string, ValidationFinding[]>(files.map((file) => [file.path, []]));
  const stageIds = new Map(files.map((file) => [file.path, stageIdsForFile(file.path, draft)]));
  const pipelineFile = files.find((file) => file.kind === "pipeline");
  const taskFile = files.find((file) => file.kind === "task");
  for (const finding of findings) {
    if (finding.severity !== "error") continue;
    const target =
      files.find((file) => pathMatches(file.path, finding.path)) ??
      (finding.stageId
        ? files.find((file) => stageIds.get(file.path)?.has(finding.stageId as string))
        : undefined) ??
      (finding.code.startsWith("task.") ? taskFile : pipelineFile);
    if (target) byPath.get(target.path)?.push(finding);
  }
  return byPath;
}

function statusFor(action: DraftPlanFile["action"] | null): {
  statusLabel: string | null;
  statusPill: boolean;
  muted: boolean;
} {
  if (action === "new") return { statusLabel: "new", statusPill: true, muted: false };
  if (action === "overwrite") {
    return { statusLabel: "exists · will overwrite", statusPill: true, muted: false };
  }
  if (action === "unchanged") {
    return { statusLabel: "exists · unchanged, skipped", statusPill: false, muted: true };
  }
  return { statusLabel: null, statusPill: false, muted: false };
}

function buildRows(
  files: Array<{
    path: string;
    kind: DraftPlanFile["kind"];
    action: DraftPlanFile["action"] | null;
    added: number;
    removed: number;
  }>,
  draft: DraftPackagePayload,
  findings: ValidationFinding[],
): SavePlanRow[] {
  const assigned = assignFindingsToFiles(files, draft, findings);
  return files.map((file) => {
    const errorCount = assigned.get(file.path)?.length ?? 0;
    return {
      ...file,
      ...statusFor(file.action),
      taskAttached: file.kind === "task",
      errorCount,
      errorLabel: errorCount > 0 ? plural(errorCount, "error") : null,
    };
  });
}

export function planRows(
  plan: DraftPlanResult,
  draft: DraftPackagePayload,
  findings: ValidationFinding[],
): SavePlanRow[] {
  return buildRows(plan.files, draft, findings);
}

export function fallbackRows(
  draft: DraftPackagePayload,
  directory: string,
  pipelineId: string,
  findings: ValidationFinding[],
): SavePlanRow[] {
  const id = pipelineId.trim() || draft.pipeline.id || "untitled";
  const files: Array<{
    path: string;
    kind: DraftPlanFile["kind"];
    action: null;
    added: number;
    removed: number;
  }> = [{ path: joinPath(directory, `${id}.yaml`), kind: "pipeline", action: null, added: 0, removed: 0 }];
  for (const stage of draft.stages ?? []) {
    files.push({ path: joinPath(directory, stage.path), kind: "stage", action: null, added: 0, removed: 0 });
  }
  if (draft.task) {
    files.push({
      path: joinPath(directory, basename(draft.task.filename)),
      kind: "task",
      action: null,
      added: 0,
      removed: 0,
    });
  }
  return buildRows(files, draft, findings);
}

export function planSummary(plan: DraftPlanResult): string {
  let created = 0;
  let overwritten = 0;
  let skipped = 0;
  for (const file of plan.files) {
    if (file.action === "new") created += 1;
    else if (file.action === "overwrite") overwritten += 1;
    else skipped += 1;
  }
  const parts = [
    created ? `${created} new` : null,
    overwritten ? `${overwritten} overwrite` : null,
    skipped ? `${skipped} skipped` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "nothing to write";
}

export function filesToWriteCount(plan: DraftPlanResult): number {
  return plan.files.filter((file) => file.action !== "unchanged").length;
}

export function pipelineIdHint(input: {
  pipelineId: string;
  initialPipelineId: string;
  mode: SaveDialogMode;
  plan: DraftPlanResult | null;
  planLoading: boolean;
}): PipelineIdHint | null {
  const id = input.pipelineId.trim();
  if (!id) return { text: "id required", tone: "warn" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { text: "invalid id", tone: "warn" };
  if (input.planLoading) return { text: "checking…", tone: "muted" };
  if (!input.plan) return null;
  if (!input.plan.pipelineIdTaken) return { text: "id is free", tone: "muted" };
  if (input.mode === "overwrite" && id === input.initialPipelineId.trim()) {
    return { text: "overwrites saved pipeline", tone: "muted" };
  }
  return { text: "id already exists", tone: "warn" };
}

export function unrewrittenStagesFootnote(draft: DraftPackagePayload): string | null {
  const refs: Array<{ id: string; uses: string }> = [];
  for (const ref of draft.pipeline.stages) {
    if (typeof ref.uses !== "string" || !ref.uses.trim()) continue;
    const uses = ref.uses;
    if ((draft.stages ?? []).some((stage) => pathMatches(stage.path, uses))) continue;
    refs.push({ id: typeof ref.id === "string" ? ref.id : basename(uses), uses: normalizePath(uses) });
  }
  if (refs.length === 0) return null;
  if (refs.length === 1) {
    return `${refs[0].id} references the existing ${refs[0].uses} and is not rewritten.`;
  }
  const ids = refs.map((ref) => ref.id);
  const list = `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
  return `${list} reference existing stage files and are not rewritten.`;
}

export function validationView(validation: DraftValidationResult | null): ValidationView {
  if (!validation) return { status: "none" };
  const errors = validation.findings.filter((finding) => finding.severity === "error");
  const warnings = validation.findings.filter((finding) => finding.severity === "warning").length;
  if (errors.length > 0) {
    return {
      status: "failed",
      title: `Validation failed · ${plural(errors.length, "error")}`,
      errors: errors.length,
      lines: errors.map((finding) => ({
        finding,
        location: findingLocation(finding),
        message: finding.message,
      })),
    };
  }
  return {
    status: "passed",
    title: warnings > 0 ? `Validation passed · ${plural(warnings, "warning")}` : "Validation passed",
    warnings,
  };
}

export function canSave(input: {
  validation: ValidationView;
  allowInvalid: boolean;
  saving: boolean;
  pipelineId: string;
}): boolean {
  if (input.saving || !input.pipelineId.trim()) return false;
  if (input.validation.status === "failed" && !input.allowInvalid) return false;
  return true;
}

export function footerHint(input: {
  validation: ValidationView;
  allowInvalid: boolean;
  plan: DraftPlanResult | null;
}): string {
  const { validation } = input;
  if (validation.status === "failed") {
    if (input.allowInvalid) return `Saving with ${plural(validation.errors, "error")}`;
    return validation.errors === 1
      ? "Fix the error or check Save invalid anyway"
      : "Fix the errors or check Save invalid anyway";
  }
  if (validation.status === "none") return "Validates before writing";
  if (input.plan) return `Writes ${plural(filesToWriteCount(input.plan), "file")}`;
  return "Ready to save";
}
