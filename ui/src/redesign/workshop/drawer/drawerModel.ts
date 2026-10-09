import type { ValidationFinding, WorkshopChatProposalPayload } from "../../../api";
import { formatFindingLocation } from "../../problemsLocation";
import { formatAgo, toEpochMs, type TimeInput } from "../relativeTime";

export type WorkshopDrawerTab = "task" | "problems" | "changes";

export type WorkshopMutationCard = {
  proposal: WorkshopChatProposalPayload;
  status: "pending" | "accepted" | "rejected" | "conflict";
  notice?: string;
  auto?: boolean;
  at?: number;
};

export type WorkshopDrawerTask = {
  filename: string;
  body: Record<string, unknown>;
  path?: string | null;
};

export type WorkshopTaskOption = { id: string; path: string };

export type FindingSeverity = "error" | "warning" | "info";

export type ProblemsBadge =
  | { kind: "unvalidated"; label: string }
  | { kind: "errors"; count: number; label: string }
  | { kind: "count"; count: number; label: string };

export type ChangeRowStatus = "pending" | "accepted" | "auto" | "rejected" | "conflict";

export type ChangeRowView = {
  id: string;
  status: ChangeRowStatus;
  summary: string;
  fileCount: number;
  filesLabel: string;
  added: number;
  removed: number;
  at?: number;
  notice?: string;
  artifacts: WorkshopChatProposalPayload["artifacts"];
};

export type MessageSegment = { text: string; code: boolean };

export type TaskFieldRow = { key: string; value: string };

const FIELD_BY_CODE: Record<string, string> = {
  invalid_completion: "verify",
  invalid_verify: "verify",
  invalid_pre_emit_checks: "verify",
  invalid_recovery: "on_verify_fail",
  io_incompatible: "io",
  invalid_io: "io",
  invalid_model: "model",
  missing_model: "model",
  model_applies: "model",
  invalid_payload_schema: "payload_schema",
  unresolved_schema_ref: "payload_schema",
  invalid_gate_kinds: "ask_operator",
  invalid_timeout_ms: "timeout_ms",
  invalid_skill: "skills",
  invalid_mcp: "mcp",
  invalid_browser: "browser",
  invalid_secrets: "secrets",
  unknown_secret: "secrets",
  denied_secret: "secrets",
  invalid_requires: "requires",
  requires_conflict: "requires",
  invalid_agent: "agent",
  route_if_invalid: "route",
  route_all_gated: "route",
  dag_error: "needs",
  missing_stage: "stages",
  stage_id_mismatch: "id",
  id_filename_mismatch: "id",
  entry_input_unmet: "input",
};

export function findingSeverity(finding: ValidationFinding): FindingSeverity {
  const severity = finding.severity as string;
  if (severity === "error" || severity === "warning") return severity;
  return "info";
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[findingSeverity(a.finding)] -
          SEVERITY_RANK[findingSeverity(b.finding)] || a.index - b.index,
    )
    .map((entry) => entry.finding);
}

export function countBySeverity(findings: ValidationFinding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[findingSeverity(finding)] += 1;
  return counts;
}

export function findingField(finding: ValidationFinding): string | null {
  const dot = finding.code.indexOf(".");
  const suffix = dot >= 0 ? finding.code.slice(dot + 1) : finding.code;
  return FIELD_BY_CODE[suffix] ?? null;
}

export function findingLocation(finding: ValidationFinding): string {
  const field = findingField(finding);
  if (finding.stageId) return field ? `${finding.stageId}.${field}` : finding.stageId;
  if (finding.pipelineId && finding.code.startsWith("pipeline.")) {
    return field ? `${finding.pipelineId}.${field}` : finding.pipelineId;
  }
  const path = finding.path.trim();
  if (path === "<draft>") return "draft";
  return formatFindingLocation(path);
}

export function findingKey(finding: ValidationFinding, index: number): string {
  return `${finding.code}:${finding.path}:${finding.stageId ?? ""}:${index}`;
}

export function messageSegments(message: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pattern = /"([^"\n]+)"|`([^`\n]+)`/g;
  let last = 0;
  for (const match of message.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: message.slice(last, start), code: false });
    segments.push({ text: match[1] ?? match[2] ?? "", code: true });
    last = start + match[0].length;
  }
  if (last < message.length) segments.push({ text: message.slice(last), code: false });
  return segments;
}

export function problemsBadge(findings: ValidationFinding[] | null): ProblemsBadge {
  if (findings === null) return { kind: "unvalidated", label: "—" };
  const counts = countBySeverity(findings);
  if (counts.error > 0) return { kind: "errors", count: counts.error, label: String(counts.error) };
  return { kind: "count", count: findings.length, label: String(findings.length) };
}

export function taskDisplayId(task: WorkshopDrawerTask): string {
  const id = task.body.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  const base = task.filename.split(/[\\/]/).pop() ?? task.filename;
  return base.replace(/\.task\.ya?ml$|\.ya?ml$/i, "");
}

export function taskTabSuffix(task: WorkshopDrawerTask | null | undefined): string | null {
  return task ? `· ${taskDisplayId(task)}` : null;
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || '""';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return `[${value.map((item) => String(item)).join(", ")}]`;
    }
    return `${value.length} items`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length ? `{ ${keys.join(", ")} }` : "{}";
}

export function taskFieldRows(body: Record<string, unknown>): TaskFieldRow[] {
  return Object.entries(body).map(([key, value]) => ({
    key,
    value: formatFieldValue(value),
  }));
}

export function filterTasks(tasks: WorkshopTaskOption[], query: string): WorkshopTaskOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tasks;
  return tasks.filter(
    (task) =>
      task.id.toLowerCase().includes(needle) || task.path.toLowerCase().includes(needle),
  );
}

function splitLines(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineDelta(
  before: string | undefined,
  after: string | undefined,
): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (!a.length || !b.length) return { added: b.length, removed: a.length };
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[b.length];
  return { added: b.length - common, removed: a.length - common };
}

export function artifactsDelta(
  artifacts: WorkshopChatProposalPayload["artifacts"],
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const artifact of artifacts) {
    const delta =
      artifact.kind === "added"
        ? lineDelta(undefined, artifact.after)
        : artifact.kind === "removed"
          ? lineDelta(artifact.before, undefined)
          : lineDelta(artifact.before, artifact.after);
    added += delta.added;
    removed += delta.removed;
  }
  return { added, removed };
}

function rowStatus(card: WorkshopMutationCard): ChangeRowStatus {
  if (card.status === "accepted" && card.auto) return "auto";
  return card.status;
}

export function changeRows(cards: ReadonlyMap<string, WorkshopMutationCard>): ChangeRowView[] {
  return [...cards.entries()]
    .map(([id, card], index) => {
      const { added, removed } = artifactsDelta(card.proposal.artifacts);
      const fileCount = card.proposal.artifacts.length;
      const row: ChangeRowView = {
        id,
        status: rowStatus(card),
        summary: card.proposal.summary.trim() || "Draft change",
        fileCount,
        filesLabel: `${fileCount} ${fileCount === 1 ? "file" : "files"}`,
        added,
        removed,
        artifacts: card.proposal.artifacts,
        ...(card.at !== undefined ? { at: card.at } : {}),
        ...(card.notice ? { notice: card.notice } : {}),
      };
      return { row, index };
    })
    .sort((a, b) => (b.row.at ?? 0) - (a.row.at ?? 0) || b.index - a.index)
    .map((entry) => entry.row);
}

export function changeStatusLabel(status: ChangeRowStatus): string {
  switch (status) {
    case "pending":
      return "Pending review";
    case "accepted":
      return "Accepted";
    case "auto":
      return "Auto-applied";
    case "rejected":
      return "Rejected · undone";
    case "conflict":
      return "Conflict";
  }
}

export function validatedMeta(
  validatedAt: TimeInput | null | undefined,
  busy: boolean,
  now: number = Date.now(),
): string | null {
  if (busy) return "validating…";
  if (validatedAt === null || validatedAt === undefined) return null;
  if (!Number.isFinite(toEpochMs(validatedAt))) return null;
  return `validated ${formatAgo(validatedAt, now)}`;
}
