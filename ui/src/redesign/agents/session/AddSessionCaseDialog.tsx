import { useEffect, useMemo, useState } from "react";
import { createEvalDataset, fetchEvalDatasets, fetchEvals } from "../../../api";
import type { AgentSessionDetail } from "../../../api/agents";
import type { EvalCreateDatasetInput, EvalDatasetListItem } from "../../../api/evalTypes";
import { datasetPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { BTN, BTN_PRIMARY, DialogShell, INPUT, LABEL, MONO } from "../../evals/datasets/DialogShell";
import { ScenarioEditor } from "../../evals/datasets/ScenarioEditor";
import {
  NEW_DATASET,
  datasetChoices,
  datasetNameError,
  defaultDatasetName,
  scenarioFromSession,
  scenarioSummary,
  toolNames,
  type SessionScenario,
} from "./sessionCaseModel";

type Props = { agentId: string; detail: AgentSessionDetail; onClose: () => void };

/** Nothing is written until Add; the generated scenario can be edited first. */
export function AddSessionCaseDialog({ agentId, detail, onClose }: Props) {
  const [scenario, setScenario] = useState<SessionScenario | null>(() => scenarioFromSession(detail));
  const [datasets, setDatasets] = useState<EvalDatasetListItem[] | null>(null);
  const [agentEvalIds, setAgentEvalIds] = useState<string[]>([]);
  const [choice, setChoice] = useState<string>(NEW_DATASET);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchEvalDatasets(), fetchEvals({ agent: agentId }).catch(() => ({ items: [] }))]).then(
      ([list, evals]) => {
        if (cancelled) return;
        setDatasets(list.items);
        setAgentEvalIds(evals.items.map((e) => e.id));
        setName(defaultDatasetName(agentId, list.items.map((d) => d.id)));
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const choices = useMemo(() => datasetChoices(datasets ?? [], agentEvalIds), [datasets, agentEvalIds]);
  const taken = (datasets ?? []).map((d) => d.id);
  const nameError = choice === NEW_DATASET && datasets ? datasetNameError(name, taken) : null;
  const target = choices.find((c) => c.id === choice);
  const ready = scenario !== null && datasets !== null && !busy && (choice === NEW_DATASET ? !nameError : target !== undefined);

  async function confirm() {
    if (!scenario) return;
    setBusy(true);
    setError(null);
    try {
      const body: EvalCreateDatasetInput =
        choice === NEW_DATASET
          ? { name, cases: [scenario] }
          : {
              ...(target?.projectRoot ? { project_root: target.projectRoot } : {}),
              dataset_id: choice,
              mode: "append",
              cases: [scenario],
              base_hash: target?.hash ?? "",
            };
      const out = await createEvalDataset(body);
      showToast(`Added to ${out.id}`);
      onClose();
      navigate(datasetPath(out.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = (scenario?.input ?? {}) as { script?: string[]; opening?: string };
  const expectedTools = ((scenario?.expected ?? {}) as { tools?: string[] }).tools ?? [];

  return (
    <>
      <DialogShell
        title="Add as eval case"
        subtitle="Builds a scripted scenario from this session's user messages. Nothing is written until you add it."
        onClose={onClose}
        footer={
          <>
            <span className="min-w-0 text-xs text-[var(--sf-fail)]" role={error ? "alert" : undefined}>{error}</span>
            <span className="flex shrink-0 items-center gap-2">
              <button type="button" className={BTN} onClick={onClose}>Cancel</button>
              <button type="button" className={BTN_PRIMARY} disabled={!ready} onClick={() => void confirm()}>
                {choice === NEW_DATASET ? "Create dataset" : "Add to dataset"}
              </button>
            </span>
          </>
        }
      >
        {scenario === null ? (
          <p className="py-6 text-center text-[13px] text-[var(--sf-text-2)]">This session has no user messages to build a scenario from.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <span className={LABEL}>Dataset</span>
              {datasets === null && !error ? <p className="text-xs text-[var(--sf-text-3)]">Loading datasets…</p> : null}
              {datasets !== null ? (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[13px] text-[var(--sf-text-1)]">
                    <input type="radio" name="dataset" checked={choice === NEW_DATASET} onChange={() => setChoice(NEW_DATASET)} />
                    New dataset
                  </label>
                  {choice === NEW_DATASET ? (
                    <div className="ml-6 flex flex-col gap-1">
                      <input aria-label="Dataset name" className={`${INPUT} ${MONO}`} value={name} onChange={(e) => setName(e.target.value)} />
                      {nameError ? <span className="text-xs text-[var(--sf-fail)]">{nameError}</span> : null}
                    </div>
                  ) : null}
                  {choices.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-[13px] text-[var(--sf-text-1)]">
                      <input type="radio" name="dataset" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                      <span className={MONO}>{c.label}</span>
                      {c.forAgent ? <span className="text-[11px] text-[var(--sf-text-3)]">used by this agent's evals</span> : null}
                    </label>
                  ))}
                </div>
              ) : null}
            </section>
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className={LABEL}>Scenario</span>
                <button type="button" className="text-[13px] font-medium text-[var(--sf-text-1)] underline" onClick={() => setEditing(true)}>Edit</button>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">{scenario.title}</span>
                  <span className={`${MONO} shrink-0 text-[11px] text-[var(--sf-text-3)]`}>{scenario.id}</span>
                </div>
                <ol className="flex flex-col gap-1 text-xs text-[var(--sf-text-2)]">
                  {(input.script ?? []).map((m, i) => (
                    <li key={i} className="truncate" title={m}>{i + 1}. {m}</li>
                  ))}
                </ol>
                <span className="text-[11px] text-[var(--sf-text-3)]">
                  {scenarioSummary(scenario)}
                  {expectedTools.length > 0 ? ` · ${expectedTools.join(", ")}` : ""} · tag from-session
                </span>
              </div>
              <p className="text-[11px] leading-[1.5] text-[var(--sf-text-3)]">
                Expected tools are the tools this session called; remove any the agent should not be required to call. Tool results are not copied.
              </p>
            </section>
          </div>
        )}
      </DialogShell>
      {editing && scenario ? (
        <ScenarioEditor
          initial={scenario}
          defaultMode="simulated"
          existingIds={[]}
          toolIds={toolNames(detail)}
          onClose={() => setEditing(false)}
          onSave={(c) => {
            setScenario(c);
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}
