import { useState } from "react";
import type { EvalAgentTarget, EvalDatasetListItem, EvalListItem } from "../../../api/evalTypes";
import { AgentPicker } from "../newEval/AgentPicker";
import { agentTargetOf } from "../newEval/wizardModel";
import { BTN, BTN_PRIMARY, DialogShell } from "../datasets/DialogShell";
import { MONO } from "../newEval/parts";
import { StagePicker } from "../newEval/StagePicker";
import { targetFromRow, type StageRow, type WizardTarget } from "../newEval/wizardModel";
import { sameFile } from "./editModel";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogShell
      title={title}
      width="w-[460px]"
      onClose={onCancel}
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onCancel}>{cancelLabel}</button>
            <button type="button" className={BTN_PRIMARY} onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </>
      }
    >
      <p className="text-[13px] text-[var(--sf-text-2)]">{body}</p>
    </DialogShell>
  );
}

export function ChangeTargetDialog({
  rows,
  evals,
  loading,
  error,
  current,
  onClose,
  onConfirm,
}: {
  rows: StageRow[];
  evals: EvalListItem[];
  loading: boolean;
  error: string | null;
  current: WizardTarget | null;
  onClose: () => void;
  onConfirm: (target: WizardTarget) => void;
}) {
  const [target, setTarget] = useState<WizardTarget | null>(current);
  const changed = target !== null && JSON.stringify(target) !== JSON.stringify(current);
  return (
    <DialogShell
      title="Change target stage"
      subtitle="Pick the stage this eval checks. The dataset cases must match the new stage's input."
      onClose={onClose}
      footer={
        <>
          <span className="text-xs text-[var(--sf-text-3)]">Nothing is written until you save the eval.</span>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={!changed} onClick={() => target && onConfirm(target)}>Use this stage</button>
          </div>
        </>
      }
    >
      <StagePicker
        rows={rows}
        evals={evals}
        loading={loading}
        error={error}
        target={target}
        listClass="max-h-[360px]"
        onPick={(row, pipelinePath) => {
          if (row.readOnly) return;
          setTarget(targetFromRow(row, pipelinePath !== undefined ? { pipelinePath } : {}));
        }}
      />
    </DialogShell>
  );
}

export function ChangeDatasetDialog({
  datasets,
  evalDir,
  currentDataset,
  loading,
  onClose,
  onConfirm,
}: {
  datasets: EvalDatasetListItem[];
  evalDir: string;
  currentDataset: string;
  loading: boolean;
  onClose: () => void;
  onConfirm: (dataset: EvalDatasetListItem) => void;
}) {
  const currentPath = (ds: EvalDatasetListItem) => sameFile(`${evalDir}/${currentDataset}`, ds.path);
  const [picked, setPicked] = useState<EvalDatasetListItem | null>(datasets.find(currentPath) ?? null);
  const changed = picked !== null && !currentPath(picked);
  return (
    <DialogShell
      title="Change dataset"
      subtitle="Pick one of the datasets in this project. Add new ones on the Datasets page."
      onClose={onClose}
      footer={
        <>
          <span className="text-xs text-[var(--sf-text-3)]">The new dataset is checked against the stage when you pick it.</span>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={!changed} onClick={() => picked && onConfirm(picked)}>Use this dataset</button>
          </div>
        </>
      }
    >
      <div className="max-h-[360px] overflow-y-auto rounded-lg border border-[var(--sf-hairline)]" role="radiogroup" aria-label="Datasets">
        {loading ? <p className="p-3 text-xs text-[var(--sf-text-3)]">Loading datasets…</p> : null}
        {!loading && datasets.length === 0 ? <p className="p-3 text-xs text-[var(--sf-text-3)]">No datasets yet.</p> : null}
        {datasets.map((ds) => {
          const active = picked?.path === ds.path;
          return (
            <button
              key={ds.path}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPicked(ds)}
              className={`grid w-full grid-cols-[18px_minmax(0,1fr)_90px_minmax(0,1fr)] items-center gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2.5 text-left text-[13px] last:border-b-0 ${active ? "bg-[var(--sf-raised)]" : ""}`}
            >
              <span className={`size-3.5 rounded-full border ${active ? "border-[var(--sf-text-1)] bg-[var(--sf-text-1)]" : "border-[var(--sf-hairline-strong)]"}`} />
              <span className={`${MONO} truncate text-[var(--sf-text-1)]`}>{ds.id}</span>
              <span className="text-xs text-[var(--sf-text-3)]">{ds.cases} {ds.cases === 1 ? "case" : "cases"}</span>
              <span className={`${MONO} truncate text-xs text-[var(--sf-text-3)]`}>{ds.path}</span>
            </button>
          );
        })}
      </div>
    </DialogShell>
  );
}

export function ChangeAgentDialog({
  items,
  loading,
  error,
  currentAgent,
  onRetry,
  onClose,
  onConfirm,
}: {
  items: EvalAgentTarget[];
  loading: boolean;
  error: string | null;
  currentAgent: string | null;
  onRetry: () => void;
  onClose: () => void;
  onConfirm: (agent: EvalAgentTarget) => void;
}) {
  const [picked, setPicked] = useState<EvalAgentTarget | null>(items.find((a) => a.id === currentAgent) ?? null);
  const changed = picked !== null && picked.id !== currentAgent;
  return (
    <DialogShell
      title="Change target agent"
      subtitle="Pick the agent this eval checks. The scenarios are checked against it when you save."
      onClose={onClose}
      footer={
        <>
          <span className="text-xs text-[var(--sf-text-3)]">Nothing is written until you save the eval.</span>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={!changed} onClick={() => picked && onConfirm(picked)}>Use this agent</button>
          </div>
        </>
      }
    >
      <AgentPicker
        items={items}
        loading={loading}
        error={error}
        target={picked ? agentTargetOf(picked) : null}
        onRetry={onRetry}
        listClass="max-h-[360px]"
        onPick={setPicked}
      />
    </DialogShell>
  );
}
