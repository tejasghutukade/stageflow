import { useMemo, useState } from "react";
import { LuClipboardList, LuFileText, LuFlaskConical, LuHistory, LuUpload } from "react-icons/lu";
import { CandidatesDialog, UploadDialog, type UploadConfirm } from "../datasets";
import { formatCost } from "../format";
import { CARD, CheckList, Chip, Field, MONO, NumberField, SELECT, Section, YamlBlock } from "./parts";
import { StagePicker } from "./StagePicker";
import type { StageInputField } from "./stageInput";
import type { WizardData } from "./useWizardData";
import type { WizardPreview } from "./useWizardPreview";
import {
  JUDGE_SAME_HINT,
  estimateText,
  holdsCases,
  datasetFilePath,
  datasetFromConfirm,
  datasetFromRuns,
  datasetFromSample,
  datasetSummary,
  datasetTarget,
  defaultsErrors,
  evalFilePath,
  judgeSameAsStage,
  parsePercent,
  percentText,
  previewRowsOf,
  sameTarget,
  sampleCompatibility,
  setupChecks,
  targetFromRow,
  visibleFindings,
  withTarget,
  type StageRow,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

type Props = {
  data: WizardData;
  draft: WizardDraft;
  setDraft: (next: WizardDraft | ((d: WizardDraft) => WizardDraft)) => void;
  fields: StageInputField[] | null | undefined;
  preview: WizardPreview;
  dirs: WriteDirs;
};

type Dialog = null | { kind: "upload"; mode: "file" | "paste" } | { kind: "runs" };

const TILE = "flex flex-col gap-1 rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-50";

export function SetupStep({ data, draft, setDraft, fields, preview, dirs }: Props) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const taken = useMemo(() => ({ evals: data.evals.map((e) => e.id), datasets: data.datasets.map((d) => d.id) }), [data]);
  const errors = defaultsErrors(draft.defaults);
  const t = draft.target;
  const selectedRow = data.rows.find((r) => sameTarget(r, t)) ?? null;
  const known = fields ?? null;
  const sample = sampleCompatibility(fields === undefined ? null : known);
  const ds = draft.dataset;
  const stageId = t?.stageId ?? "stage";
  const judgeModels = data.models.filter((m) => m.judge_capable !== false);
  const hint = judgeSameAsStage(draft);

  function pick(row: StageRow, pipelinePath?: string) {
    if (row.readOnly) return;
    const next = targetFromRow(row, pipelinePath !== undefined ? { pipelinePath } : {});
    setDraft((d) => withTarget(d, next, null, taken.evals));
  }

  function confirmUpload(req: UploadConfirm) {
    setDraft((d) => ({ ...d, dataset: datasetFromConfirm(req, dialog?.kind === "upload" && dialog.mode === "paste" ? "paste" : "upload", stageId, taken.datasets) }));
    setDialog(null);
  }

  const findings = visibleFindings(preview.findings, holdsCases(draft));
  const checks = setupChecks(draft, findings);
  const evalPath = evalFilePath(dirs, draft.id);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-6 overflow-y-auto px-7 py-5">
      <div className="flex min-w-0 flex-col gap-4">
        <Section
          n={1}
          title="Target"
          hint="What do you want to check?"
          right={
            <span className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5 text-xs">
              <span className="rounded-md bg-[var(--sf-raised)] px-2.5 py-1 text-[var(--sf-text-1)]">Stage</span>
              <span className="px-2.5 py-1 text-[var(--sf-text-3)]" aria-disabled>Agent <span className="text-[10px]">soon</span></span>
            </span>
          }
        >
          <StagePicker rows={data.rows} evals={data.evals} loading={data.loading} error={data.error} target={t} onPick={pick} />
          {t ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sf-hairline)] px-3 py-2.5">
              <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>io.input</span>
              {fields === undefined ? <span className="text-xs text-[var(--sf-text-3)]">Reading the stage…</span> : null}
              {fields === null ? <span className="text-xs text-[var(--sf-text-3)]">The input fields could not be read.</span> : null}
              {(fields ?? []).map((f) => (
                <span key={f.name} className={`${MONO} rounded border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-1.5 py-0.5 text-xs text-[var(--sf-text-1)]`}>
                  {f.name}{f.required ? "" : "?"}{f.type ? `: ${f.type}` : ""}
                </span>
              ))}
              <span className="ml-auto text-xs text-[var(--sf-text-3)]">Every case needs these fields</span>
            </div>
          ) : null}
        </Section>

        <Section n={2} title="Dataset" hint="The cases the stage will be run on">
          <div className="grid grid-cols-4 gap-3">
            <button type="button" disabled={!t} onClick={() => setDialog({ kind: "upload", mode: "file" })} className={`${TILE} ${ds?.source === "upload" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
              <LuUpload className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Upload a file</span>
              <span className="text-xs text-[var(--sf-text-3)]">JSONL, JSON or CSV</span>
            </button>
            <button type="button" disabled={!t} onClick={() => setDialog({ kind: "upload", mode: "paste" })} className={`${TILE} ${ds?.source === "paste" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
              <LuClipboardList className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Paste or type</span>
              <span className="text-xs text-[var(--sf-text-3)]">Add cases in a table</span>
            </button>
            <button type="button" disabled={!t} onClick={() => setDialog({ kind: "runs" })} className={`${TILE} ${ds?.source === "runs" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
              <LuHistory className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">From past runs</span>
              <span className="text-xs text-[var(--sf-text-3)]">Pick real inputs this stage received</span>
            </button>
            <button
              type="button"
              disabled={!t || !sample.ok}
              title={sample.ok ? undefined : sample.reason}
              onClick={() => setDraft((d) => ({ ...d, dataset: datasetFromSample(stageId, taken.datasets) }))}
              className={`${TILE} ${ds?.source === "sample" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}
            >
              <LuFlaskConical className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Try sample data</span>
              <span className="text-xs text-[var(--sf-text-3)]">{t && !sample.ok ? sample.reason : "8 demo cases, no setup"}</span>
            </button>
          </div>
          {ds ? (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-[var(--sf-hairline)] px-3 py-2.5 text-[13px]">
                <LuFileText className="size-4 text-[var(--sf-text-3)]" aria-hidden />
                <span className={`${MONO} text-[var(--sf-text-1)]`}>{ds.fileName}</span>
                <span className="text-[var(--sf-text-3)]">{datasetSummary(ds).title}</span>
                <span className={ds.skipped > 0 ? "text-[var(--sf-warn,#e5a50a)]" : "text-[var(--sf-pass,#3ecf8e)]"}>{datasetSummary(ds).match}</span>
                <span className={`${MONO} ml-auto text-xs text-[var(--sf-text-3)]`}>{datasetFilePath(dirs, ds.name)}</span>
                <button type="button" className="text-[var(--sf-text-1)] underline-offset-2 hover:underline" onClick={() => setDialog({ kind: "upload", mode: "file" })}>Replace</button>
              </div>
              {ds.cases || ds.runPreviews.length > 0 ? (
                <PreviewTable ds={ds} fields={(fields ?? []).map((f) => f.name)} />
              ) : (
                <p className="text-xs text-[var(--sf-text-3)]">The sample cases are copied when you create the eval.</p>
              )}
            </>
          ) : (
            <p className="text-xs text-[var(--sf-text-3)]">{t ? "Add the cases the stage will run on." : "Pick a stage first."}</p>
          )}
        </Section>

        <Section n={3} title="Run defaults" hint="You can change these for any single run">
          <div className="grid grid-cols-4 gap-3">
            <Field label="Repeats per case" hint="Models answer differently each time" error={errors.repeats}>
              <NumberField value={draft.defaults.repeats} parse={(x) => (x.trim() === "" ? null : Number(x))} show={String} error={errors.repeats} onCommit={(n) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, repeats: n } }))} />
            </Field>
            <Field label="Judge model" {...(hint ? { warn: JUDGE_SAME_HINT } : {})}>
              <select className={SELECT} value={draft.defaults.judge ?? ""} onChange={(e) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, judge: e.target.value === "" ? null : e.target.value } }))}>
                <option value="">None yet</option>
                {judgeModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
                {draft.defaults.judge && !judgeModels.some((m) => m.id === draft.defaults.judge) ? <option value={draft.defaults.judge}>{draft.defaults.judge}</option> : null}
              </select>
            </Field>
            <Field label="Pass threshold" hint="Run passes at or above this score" error={errors.passThreshold}>
              <NumberField value={draft.defaults.passThreshold} parse={parsePercent} show={(n) => `${percentText(n)}%`} error={errors.passThreshold} onCommit={(n) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, passThreshold: n } }))} />
            </Field>
            <Field label="Cost limit per run" hint="The run stops here" error={errors.maxCostUsd}>
              <NumberField value={draft.defaults.maxCostUsd} prefix="$" parse={(x) => (x.trim() === "" ? null : Number(x.replace(/^\$/, "")))} show={(n) => (Number.isFinite(n) ? n.toFixed(2) : "")} error={errors.maxCostUsd} onCommit={(n) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, maxCostUsd: n } }))} />
            </Field>
          </div>
          <div className="flex flex-col gap-2 border-t border-t-[var(--sf-hairline)] pt-3">
            <span className="text-[13px] text-[var(--sf-text-2)]">What is this eval for?</span>
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Eval type">
              {(
                [
                  ["capability", "Capability: what can it do?", "Hard cases, expected to start with a low pass rate. A hill to climb."],
                  ["regression", "Regression: does it still work?", "Cases it already handles. Should stay near 100%; a drop means something broke."],
                ] as const
              ).map(([value, title, body]) => (
                <button key={value} type="button" role="radio" aria-checked={draft.type === value} onClick={() => setDraft((d) => ({ ...d, type: value }))} className={`${CARD} flex flex-col gap-1 p-3 text-left ${draft.type === value ? "border-[var(--sf-text-2)]" : ""}`}>
                  <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{title}</span>
                  <span className="text-xs text-[var(--sf-text-3)]">{body}</span>
                </button>
              ))}
            </div>
          </div>
        </Section>
      </div>

      <aside className="flex min-w-0 flex-col gap-3">
        <YamlBlock title={evalPath} yaml={preview.yaml} loading={preview.loading} badge="live preview" />
        {preview.error ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{preview.error}</p> : null}
        <div className={`${CARD} flex flex-col gap-3 p-3.5`}>
          <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Checks</span>
          <CheckList lines={checks} />
        </div>
        <div className={`${CARD} flex flex-col gap-0.5 p-3.5`}>
          <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{estimateText(preview.estimate).title}</span>
          <span className="text-xs text-[var(--sf-text-3)]">The cost limit of {formatCost(draft.defaults.maxCostUsd)} still applies.</span>
        </div>
        {selectedRow?.readOnly ? <Chip tone="warn">Read-only catalog</Chip> : null}
      </aside>

      {t && dialog?.kind === "upload" ? (
        <UploadDialog
          open
          title={dialog.mode === "paste" ? "Paste or type cases" : "Upload cases"}
          subtitle={`For the ${t.stageId} stage. Nothing is written until you create the eval.`}
          target={datasetTarget(t)}
          inputFields={fields ?? []}
          initialMode={dialog.mode}
          {...(t.projectRoot ? { projectRoot: t.projectRoot } : {})}
          onClose={() => setDialog(null)}
          onConfirm={confirmUpload}
        />
      ) : null}
      {t && dialog?.kind === "runs" ? (
        <CandidatesDialog
          open
          subtitle={`Completed runs of the ${t.stageId} stage`}
          target={datasetTarget(t)}
          {...(t.projectRoot ? { projectRoot: t.projectRoot } : {})}
          confirmText={(n) => `Use ${n} ${n === 1 ? "run" : "runs"} as cases`}
          onClose={() => setDialog(null)}
          onConfirm={(ids, items) => {
            setDraft((d) => ({ ...d, dataset: datasetFromRuns(ids, items.map((i) => i.preview), stageId, taken.datasets) }));
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PreviewTable({ ds, fields }: { ds: NonNullable<WizardDraft["dataset"]>; fields: string[] }) {
  const names = ds.cases ? (fields.length > 0 ? fields : Object.keys((ds.cases[0]?.input as Record<string, unknown>) ?? {})) : ["input"];
  const rows = previewRowsOf(ds, ds.cases ? names : []);
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)] text-xs">
      <div className="grid gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2 text-[var(--sf-text-3)]" style={{ gridTemplateColumns: `40px repeat(${names.length}, minmax(0, 1fr))` }}>
        <span>#</span>
        {names.map((n) => (
          <span key={n} className={MONO}>{n}</span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className="grid gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2 last:border-b-0" style={{ gridTemplateColumns: `40px repeat(${names.length}, minmax(0, 1fr))` }}>
          <span className="text-[var(--sf-text-3)]">{i + 1}</span>
          {r.cells.map((c, j) => (
            <span key={j} className={`${MONO} line-clamp-2 break-words text-[var(--sf-text-2)]`}>{c}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
