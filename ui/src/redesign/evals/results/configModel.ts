import type { EvalRunDetail, EvalRunOptions } from "../../../api/evalTypes";
import { formatCost } from "../format";
import { kindLabel } from "./gradersModel";
import { hash6, settingsOf, stageLabel, suiteTypeLabel } from "./headerModel";

export type Chip = { text: string; tone: "ok" | "needs" | "muted" };

export type ConfigRow = { label: string; value: string; chip?: Chip };

type Snapshot = Record<string, any>;

function target(run: EvalRunDetail): Snapshot {
  return (run.config?.target ?? {}) as Snapshot;
}

export function editedChip(snapshotHash: string | null | undefined, currentHash: string | null | undefined): Chip | null {
  if (!snapshotHash || !currentHash) return null;
  return snapshotHash === currentHash ? null : { text: `edited since: now ${hash6(currentHash)}`, tone: "needs" };
}

export function stageEdited(run: EvalRunDetail): boolean {
  return editedChip(target(run).stage_version_hash, run.current?.stage_version_hash) !== null;
}

export function datasetEdited(run: EvalRunDetail): boolean {
  const snapshot = (run.config?.dataset ?? {}) as Snapshot;
  return editedChip(snapshot.hash, run.current?.dataset_hash) !== null;
}

export function changedGraders(run: EvalRunDetail): string[] {
  const current = run.current?.grader_hashes;
  if (!current) return [];
  const snapshot: Snapshot[] = Array.isArray(run.config?.graders) ? run.config.graders : [];
  const changed = snapshot.filter((g) => current[g.id] !== undefined && current[g.id] !== g.hash).map((g) => String(g.id));
  const added = Object.keys(current).filter((id) => !snapshot.some((g) => g.id === id));
  const removed = snapshot.filter((g) => current[g.id] === undefined).map((g) => String(g.id));
  return [...changed, ...added, ...removed];
}

export function stageCard(run: EvalRunDetail): ConfigRow[] {
  const t = target(run);
  const { stage, pipeline } = stageLabel(run);
  const file = typeof t.stage_definition?.file === "string" ? t.stage_definition.file : t.file;
  const where = pipeline && stage ? `${stage} in ${pipeline}` : (stage ?? "—");
  const thinking = t.stage_definition?.thinking ?? t.stage_definition?.thinking_level;
  const model = typeof t.model === "string" && t.model !== "" ? t.model : "—";
  const chip = editedChip(t.stage_version_hash, run.current?.stage_version_hash);
  return [
    { label: "Stage", value: file && pipeline ? `${where} · ${file}` : where },
    { label: "Version", value: hash6(t.stage_version_hash), ...(chip ? { chip } : {}) },
    { label: "Model", value: typeof thinking === "string" && thinking !== "" ? `${model} · thinking ${thinking}` : model },
    { label: "Output schema", value: t.output_schema_hash ? hash6(t.output_schema_hash) : "—" },
  ];
}

export function datasetCard(run: EvalRunDetail): { status: Chip | null; rows: ConfigRow[] } {
  const d = (run.config?.dataset ?? {}) as Snapshot;
  const t = target(run);
  const current = run.current?.dataset_hash ?? null;
  const status: Chip | null =
    current === null || !d.hash
      ? null
      : current === d.hash
        ? { text: "unchanged since this run", tone: "ok" }
        : { text: `edited since: now ${hash6(current)}`, tone: "needs" };
  return {
    status,
    rows: [
      { label: "File", value: String(d.path ?? "—") },
      { label: "Content hash", value: hash6(d.hash) },
      { label: "Cases run", value: `${d.cases_run ?? 0} of ${d.case_count ?? 0} · ${d.cases_skipped ?? 0} skipped` },
      { label: "Input schema", value: t.input_schema_hash ? `io.input · ${hash6(t.input_schema_hash)}` : "—" },
    ],
  };
}

export type GraderConfigRow = {
  id: string;
  kind: string;
  weightText: string;
  hash: string;
  versionText: string | null;
  notCalibrated: boolean;
  edited: Chip | null;
};

export function gradersCard(run: EvalRunDetail): { count: number; summary: string; rows: GraderConfigRow[] } {
  const snapshot: Snapshot[] = Array.isArray(run.config?.graders) ? run.config.graders : [];
  const current = run.current?.grader_hashes ?? null;
  const rows = snapshot.map((g) => ({
    id: String(g.id),
    kind: kindLabel(String(g.type)).toLowerCase(),
    weightText: g.must_pass ? "must pass" : `×${g.weight ?? 1}`,
    hash: hash6(g.hash),
    versionText: g.type === "rubric" && g.version_ordinal ? `v${g.version_ordinal}` : null,
    notCalibrated: g.type === "rubric",
    edited: current && current[g.id] !== undefined ? editedChip(g.hash, current[g.id]) : null,
  }));
  const versions = rows.filter((r) => r.versionText).map((r) => r.versionText as string);
  const unique = [...new Set(versions)];
  return {
    count: rows.length,
    summary: unique.length === 0 ? `${rows.length}` : `${rows.length} · rubrics ${unique.join(", ")}`,
    rows,
  };
}

export function settingsCard(run: EvalRunDetail): ConfigRow[] {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const engine = (run.config?.engine ?? {}) as Snapshot;
  const threshold = Number(s.pass_threshold);
  const limit = Number(s.max_cost_usd);
  const modelNote =
    typeof overrides.model === "string" && overrides.model !== ""
      ? `stage model overridden: ${overrides.model}`
      : "stage model not overridden";
  return [
    {
      label: "Judge model",
      value: typeof s.judge === "string" && s.judge !== "" ? s.judge : "—",
      ...(s.judge_same_as_stage ? { chip: { text: "same as stage model", tone: "needs" as const } } : {}),
    },
    {
      label: "Repeats · threshold · limit",
      value: `${s.repeats ?? "—"} · ${Number.isFinite(threshold) ? threshold.toFixed(2) : "—"} · ${
        Number.isFinite(limit) ? formatCost(limit) : "—"
      } (spent ${formatCost(run.progress.cost_usd)})`,
    },
    { label: "Suite type", value: `${suiteTypeLabel(run).toLowerCase()} · ${modelNote}` },
    {
      label: "Software",
      value: `Stageflow ${run.config?.stageflow_version ?? "—"} · eval engine ${engine.name ?? "—"} ${engine.version ?? ""}`.trim(),
    },
  ];
}

export function fingerprintNote(): string {
  return "Saved with the results and never edited. Runs with the same fingerprint compare directly.";
}

export function caseSubset(run: EvalRunDetail): string[] | null {
  const ids = (run.components as { case_ids?: unknown })?.case_ids;
  return Array.isArray(ids) ? (ids as string[]) : null;
}

export function reproduceCommand(run: EvalRunDetail): string {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const parts = ["sf eval run", run.eval_path];
  if (s.repeats !== undefined) parts.push(`--repeats ${s.repeats}`);
  if (typeof s.judge === "string" && s.judge !== "") parts.push(`--judge ${s.judge}`);
  if (typeof overrides.model === "string" && overrides.model !== "") parts.push(`--model ${overrides.model}`);
  if (overrides.max_cost_usd !== null && overrides.max_cost_usd !== undefined) parts.push(`--max-cost ${s.max_cost_usd}`);
  for (const id of caseSubset(run) ?? []) parts.push(`--case ${id}`);
  return parts.join(" ");
}

export function rerunOverrides(run: EvalRunDetail): EvalRunOptions {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const out: EvalRunOptions = {};
  if (Number.isInteger(s.repeats)) out.repeats = s.repeats;
  if (typeof s.judge === "string" && s.judge !== "") out.judge = s.judge;
  if (typeof overrides.model === "string" && overrides.model !== "") out.model = overrides.model;
  if (Number.isFinite(Number(s.max_cost_usd))) out.max_cost_usd = Number(s.max_cost_usd);
  const subset = caseSubset(run);
  if (subset && subset.length > 0) out.case_ids = subset;
  return out;
}

export function rerunNote(run: EvalRunDetail): string | null {
  const names: string[] = [];
  if (stageEdited(run)) names.push("stage");
  if (datasetEdited(run)) names.push("dataset");
  if (changedGraders(run).length > 0) names.push("graders");
  if (names.length === 0) return null;
  const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `The ${joined} changed since this run; this will use the current ones.`;
}

export function exportFileName(run: Pick<EvalRunDetail, "eval_id" | "run_number">, what: "results" | "config"): string {
  return `${run.eval_id}-run-${run.run_number}-${what}.json`;
}
