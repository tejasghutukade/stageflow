import type { EvalDefinition } from "../../../api/evalTypes";
import { INPUT } from "../datasets/DialogShell";
import { CARD, Field, MONO, NumberField, SELECT } from "../newEval/parts";
import {
  JUDGE_SAME_HINT,
  DEFAULT_MAX_COST_USD,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_REPEATS,
  defaultsErrors,
  parsePercent,
  percentText,
} from "../newEval/wizardModel";
import { draftDefaults, targetSummary, withDefault, withJudge, withText, withType } from "./editModel";

const FALLBACK = { repeats: DEFAULT_REPEATS, passThreshold: DEFAULT_PASS_THRESHOLD, maxCostUsd: DEFAULT_MAX_COST_USD };

type Props = {
  definition: EvalDefinition;
  judgeModels: string[];
  targetModel: string | null;
  datasetLabel: string;
  onChange: (next: (d: EvalDefinition) => EvalDefinition) => void;
  onChangeTarget: () => void;
  onChangeDataset: () => void;
};

function ChangeInput({ value, label, onChange }: { value: string; label: string; onChange: () => void }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] pl-2.5 pr-1 text-[13px]">
      <span className={`${MONO} min-w-0 flex-1 truncate text-[var(--sf-text-1)]`} title={value}>{value}</span>
      <button type="button" onClick={onChange} aria-label={label} className="rounded-md px-2 py-1 text-xs text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]">Change</button>
    </div>
  );
}

export function DefinitionCard({ definition, judgeModels, targetModel, datasetLabel, onChange, onChangeTarget, onChangeDataset }: Props) {
  const d = draftDefaults(definition, FALLBACK);
  const errors = defaultsErrors(d);
  const judgeSame = !!d.judge && !!targetModel && d.judge === targetModel;
  return (
    <section className={`${CARD} overflow-hidden`} aria-label="Definition">
      <header className="flex items-baseline gap-2 border-b border-b-[var(--sf-hairline)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--sf-text-1)]">Definition</h2>
        <span className="text-xs text-[var(--sf-text-3)]">name, target, dataset, run defaults</span>
      </header>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
        <Field label="Name">
          <input className={INPUT} value={definition.name ?? ""} onChange={(e) => onChange((x) => withText(x, "name", e.target.value))} />
        </Field>
        <Field label="Description">
          <input className={INPUT} value={definition.description ?? ""} onChange={(e) => onChange((x) => withText(x, "description", e.target.value))} />
        </Field>
        <Field label="Target stage">
          <ChangeInput value={targetSummary(definition)} label="Change target stage" onChange={onChangeTarget} />
        </Field>
        <Field label="Dataset">
          <ChangeInput value={datasetLabel} label="Change dataset" onChange={onChangeDataset} />
        </Field>
        <Field label="Repeats per case" error={errors.repeats}>
          <NumberField value={d.repeats} parse={(x) => (x.trim() === "" ? null : Number(x))} show={String} error={errors.repeats} onCommit={(n) => onChange((x) => withDefault(x, "repeats", n))} />
        </Field>
        <Field label="Pass threshold" error={errors.passThreshold}>
          <NumberField value={d.passThreshold} parse={parsePercent} show={(n) => `${percentText(n)}%`} error={errors.passThreshold} onCommit={(n) => onChange((x) => withDefault(x, "pass_threshold", n))} />
        </Field>
        <Field label="Judge model" {...(judgeSame ? { warn: JUDGE_SAME_HINT } : {})}>
          <select className={SELECT} value={d.judge ?? ""} onChange={(e) => onChange((x) => withJudge(x, e.target.value === "" ? null : e.target.value))}>
            <option value="">None</option>
            {judgeModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {d.judge && !judgeModels.includes(d.judge) ? <option value={d.judge}>{d.judge}</option> : null}
          </select>
        </Field>
        <Field label="Cost limit per run" error={errors.maxCostUsd}>
          <NumberField value={d.maxCostUsd} prefix="$" parse={(x) => (x.trim() === "" ? null : Number(x.replace(/^\$/, "")))} show={(n) => (Number.isFinite(n) ? n.toFixed(2) : "")} error={errors.maxCostUsd} onCommit={(n) => onChange((x) => withDefault(x, "max_cost_usd", n))} />
        </Field>
        <Field label="Suite type">
          <select className={SELECT} value={definition.type ?? "capability"} onChange={(e) => onChange((x) => withType(x, e.target.value as "capability" | "regression"))}>
            <option value="capability">Capability</option>
            <option value="regression">Regression</option>
          </select>
        </Field>
      </div>
    </section>
  );
}
