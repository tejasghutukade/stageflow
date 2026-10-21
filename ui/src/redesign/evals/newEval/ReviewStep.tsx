import { INPUT, TEXTAREA } from "../datasets/DialogShell";
import { formatCost, formatPercent } from "../format";
import { describeGrader, chipFor, weightLabel } from "./graderForms";
import { CARD, Chip, Field, FindingsList, MONO, YamlBlock } from "./parts";
import type { WizardPreview } from "./useWizardPreview";
import {
  NO_COST_HISTORY,
  datasetFilePath,
  datasetSummary,
  evalFilePath,
  validateEvalId,
  visibleFindings,
  withId,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

type Props = {
  draft: WizardDraft;
  setDraft: (next: WizardDraft | ((d: WizardDraft) => WizardDraft)) => void;
  takenIds: string[];
  preview: WizardPreview;
  dirs: WriteDirs;
  datasetWritten: boolean;
  createError: string | null;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-b border-b-[var(--sf-hairline)] px-4 py-2.5 text-[13px] last:border-b-0">
      <span className="text-[var(--sf-text-3)]">{label}</span>
      <span className="min-w-0 text-[var(--sf-text-1)]">{children}</span>
    </div>
  );
}

export function ReviewStep({ draft, setDraft, takenIds, preview, dirs, datasetWritten, createError }: Props) {
  const idError = validateEvalId(draft.id, takenIds);
  const ds = draft.dataset;
  const d = draft.defaults;
  const findings = visibleFindings(preview.findings, datasetWritten);

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-7 py-5">
      <div className="flex w-full max-w-[820px] flex-col gap-5">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
          <Field label="Name" hint="Saved as the file name" error={idError ?? undefined}>
            <input className={`${INPUT} ${MONO}`} value={draft.id} onChange={(e) => setDraft((x) => withId(x, e.target.value))} aria-label="Eval name" />
          </Field>
          <Field label="Description (optional)">
            <textarea className={`${TEXTAREA} min-h-[32px]`} rows={1} maxLength={500} value={draft.description} onChange={(e) => setDraft((x) => ({ ...x, description: e.target.value }))} aria-label="Description" />
          </Field>
        </div>

        <section className={`${CARD} overflow-hidden`} aria-label="Summary">
          <Row label="Target">
            <span className={MONO}>{draft.target?.label}</span>
            {draft.target?.model ? <span className="ml-2 text-xs text-[var(--sf-text-3)]">{draft.target.model}</span> : null}
          </Row>
          <Row label="Dataset">
            {ds ? (
              <>
                <span className={MONO}>{datasetFilePath(dirs, ds.name)}</span>
                <span className="ml-2 text-xs text-[var(--sf-text-3)]">
                  {datasetSummary(ds).title} · {ds.skipped > 0 ? `${ds.skipped} skipped` : "all match"}
                  {ds.source === "sample" || ds.source === "runs" ? ` · from ${ds.source === "sample" ? "sample data" : "past runs"}` : ""}
                </span>
              </>
            ) : null}
          </Row>
          <Row label="Defaults">
            {d.repeats} repeats · pass at {formatPercent(d.passThreshold)} · limit {formatCost(d.maxCostUsd)} · judge {d.judge ?? "none"} · {draft.type}
          </Row>
          <Row label={`Graders ${draft.graders.length}`}>
            <ul className="flex flex-col gap-1.5">
              {draft.graders.map((g) => (
                <li key={g.id} className="flex items-center gap-2">
                  <Chip tone={g.type === "rubric" ? "info" : "neutral"}>{chipFor(g.type)}</Chip>
                  <span className={`${MONO} text-xs`}>{g.id}</span>
                  <span className="min-w-0 truncate text-xs text-[var(--sf-text-3)]">{describeGrader(g)}</span>
                  {g.must_pass === true ? <Chip tone="warn">must pass</Chip> : null}
                  {weightLabel(g) ? <span className="ml-auto text-xs text-[var(--sf-text-2)]">{weightLabel(g)}</span> : null}
                </li>
              ))}
            </ul>
          </Row>
        </section>

        <section className="flex flex-col gap-2" aria-label="Findings">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Findings</h2>
          <FindingsList findings={findings} />
          {preview.error ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{preview.error}</p> : null}
          {createError ? <p role="alert" className="rounded-lg border border-[var(--sf-fail)] px-3 py-2 text-[13px] text-[var(--sf-fail)]">{createError}</p> : null}
        </section>

        <div className="flex items-center justify-between text-[13px] text-[var(--sf-text-2)]">
          <span>
            Will write <span className={`${MONO} text-[var(--sf-text-1)]`}>{evalFilePath(dirs, draft.id)}</span>
            {ds && !datasetWritten ? <> and <span className={`${MONO} text-[var(--sf-text-1)]`}>{datasetFilePath(dirs, ds.name)}</span></> : null}
          </span>
          <span>{NO_COST_HISTORY}</span>
        </div>

        <YamlBlock yaml={preview.yaml} loading={preview.loading} />
      </div>
    </div>
  );
}
