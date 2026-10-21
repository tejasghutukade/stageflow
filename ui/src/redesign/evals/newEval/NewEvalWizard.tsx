import { useEffect, useMemo, useRef, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { createEval, createEvalDataset } from "../../../api/evalsClient";
import { evalPath, evalsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { PageHeader } from "../../shell/PageHeader";
import { BTN, BTN_PRIMARY } from "../datasets/DialogShell";
import { GradersStep } from "./GradersStep";
import { ReviewStep } from "./ReviewStep";
import { SetupStep } from "./SetupStep";
import { footerText } from "./graderForms";
import { useStageFields, useWizardData } from "./useWizardData";
import { useWizardPreview } from "./useWizardPreview";
import { createFromDraft } from "./wizardCreate";
import {
  SETUP_FOOTER_NOTE,
  STEP_LABELS,
  WIZARD_STEPS,
  blockingFindings,
  canContinueFromGraders,
  canContinueFromSetup,
  evalFilePath,
  goBack,
  goNext,
  initialDraft,
  preselectRow,
  sameTarget,
  validateEvalId,
  visibleFindings,
  withTarget,
  type Preselect,
  type WizardDraft,
} from "./wizardModel";

const SUBTITLES = {
  setup: "Pick the stage to check and the data to check it with. You add graders next.",
  graders: "Decide what a good result looks like. Checks are exact; rubrics are judged by a model.",
  review: "Name the eval, check the summary, then create it.",
} as const;

function Stepper({ step }: { step: WizardDraft["step"] }) {
  const current = WIZARD_STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-[13px]" aria-label="Steps">
      {WIZARD_STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === current ? "step" : undefined}>
          {i > 0 ? <span className="h-px w-6 bg-[var(--sf-hairline-strong)]" /> : null}
          <span className={`flex items-center gap-2 rounded-full px-2.5 py-1 ${i === current ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}>
            <span className={`flex size-5 items-center justify-center rounded-full text-[11px] ${i === current ? "bg-[var(--sf-text-1)] text-[var(--sf-ground)]" : "border border-[var(--sf-hairline-strong)]"}`}>
              {i < current ? <LuCheck className="size-3" aria-hidden /> : i + 1}
            </span>
            {STEP_LABELS[s]}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function NewEvalWizard({ pipeline, stage, file }: Preselect) {
  const data = useWizardData();
  const [draft, setDraft] = useState<WizardDraft>(initialDraft);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [datasetWritten, setDatasetWritten] = useState(false);
  const preselected = useRef(false);
  const takenEvalIds = useMemo(() => data.evals.map((e) => e.id), [data.evals]);
  const datasetPaths = useMemo(() => data.datasets.map((d) => d.path), [data.datasets]);

  useEffect(() => {
    if (preselected.current || data.loading) return;
    preselected.current = true;
    const hit = preselectRow(data.rows, { ...(pipeline ? { pipeline } : {}), ...(stage ? { stage } : {}), ...(file ? { file } : {}) });
    if (hit && !hit.row.readOnly) setDraft((d) => withTarget(d, hit.target, null, takenEvalIds));
  }, [data.loading, data.rows, pipeline, stage, file, takenEvalIds]);

  const row = data.rows.find((r) => sameTarget(r, draft.target)) ?? null;
  const fields = useStageFields(draft.target, row);
  const { preview, dirs } = useWizardPreview(draft, datasetPaths, draft.target !== null && draft.dataset !== null);
  const findings = visibleFindings(preview.findings, datasetWritten);
  const judgeModels = useMemo(() => data.models.filter((m) => m.judge_capable !== false).map((m) => m.id), [data.models]);

  const step = draft.step;
  const idError = validateEvalId(draft.id, takenEvalIds);
  const canCreate = !busy && idError === null && blockingFindings(findings).length === 0 && !preview.loading && preview.yaml !== "";

  async function create(run: boolean) {
    setBusy(true);
    setCreateError(null);
    const outcome = await createFromDraft(
      draft,
      dirs,
      {
        createDataset: (input) => createEvalDataset(input),
        createEval: (input) => createEval(input),
      },
      { datasetAlreadyWritten: datasetWritten },
    );
    setBusy(false);
    if (outcome.ok) {
      showToast(`Created ${outcome.evalId}`);
      navigate(run ? evalPath(outcome.evalId, { openRun: true }) : evalsPath());
      return;
    }
    if (outcome.datasetWritten) setDatasetWritten(true);
    setCreateError(outcome.message);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title="New eval"
        subtitle={SUBTITLES[step]}
        crumbs={[{ label: "Evals", onClick: () => navigate(evalsPath()) }]}
        actions={<Stepper step={step} />}
      />
      {step === "setup" ? <SetupStep data={data} draft={draft} setDraft={setDraft} fields={fields} preview={preview} dirs={dirs} /> : null}
      {step === "graders" ? <GradersStep draft={draft} setDraft={setDraft} dirs={dirs} findings={findings} judgeModels={judgeModels} /> : null}
      {step === "review" ? (
        <ReviewStep draft={draft} setDraft={setDraft} takenIds={takenEvalIds} preview={preview} dirs={dirs} datasetWritten={datasetWritten} createError={createError} />
      ) : null}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] px-7 py-3">
        <p className="min-w-0 text-[13px] text-[var(--sf-text-3)]">
          {step === "setup" ? SETUP_FOOTER_NOTE(evalFilePath(dirs, draft.id)) : null}
          {step === "graders" ? footerText(draft.graders, draft.defaults.passThreshold) : null}
          {step === "review" ? "Nothing is written until you create the eval." : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {step === "setup" ? (
            <>
              <button type="button" className={BTN} onClick={() => navigate(evalsPath())}>Cancel</button>
              <button type="button" className={BTN_PRIMARY} disabled={!canContinueFromSetup(draft)} onClick={() => setDraft(goNext)}>Continue to graders</button>
            </>
          ) : null}
          {step === "graders" ? (
            <>
              <button type="button" className={BTN} onClick={() => setDraft(goBack)}>Back</button>
              <button type="button" className={BTN_PRIMARY} disabled={!canContinueFromGraders(draft)} onClick={() => setDraft(goNext)}>Continue to review</button>
            </>
          ) : null}
          {step === "review" ? (
            <>
              <button type="button" className={BTN} disabled={busy} onClick={() => setDraft(goBack)}>Back</button>
              <button type="button" className={BTN} disabled={!canCreate} onClick={() => void create(false)}>{busy ? "Creating…" : "Create eval"}</button>
              <button type="button" className={BTN_PRIMARY} disabled={!canCreate} onClick={() => void create(true)}>Create and run</button>
            </>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
