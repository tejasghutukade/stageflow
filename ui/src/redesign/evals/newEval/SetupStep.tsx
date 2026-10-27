import { useMemo, useState } from "react";
import { LuClipboardList, LuFileText, LuFlaskConical, LuHistory, LuPencil, LuPlus, LuTrash2, LuUpload } from "react-icons/lu";
import { EvalApiError, installEvalSample } from "../../../api/evalsClient";
import type { EvalCaseInput } from "../../../api/evalTypes";
import { evalPath as evalRoute, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { CandidatesDialog, UploadDialog, type UploadConfirm } from "../datasets";
import { ScenarioEditor } from "../datasets/ScenarioEditor";
import { SessionCandidatesDialog } from "../datasets/SessionCandidatesDialog";
import { modeLabel, scenarioRow } from "../datasets/scenarioModel";
import { formatCost } from "../format";
import { JudgeModelPicker } from "../run/RunPicker";
import { countsAsJudgeModel } from "../run/runDialogModel";
import { AgentPicker, RiskBadges } from "./AgentPicker";
import { ConversationCard } from "./ConversationCard";
import { CARD, CheckList, Chip, Field, MONO, NumberField, Section, YamlBlock } from "./parts";
import { StagePicker } from "./StagePicker";
import { riskBadges, toolSummary } from "./agentPickerModel";
import { agentEstimateLines, estimateBasisText, stubbedHint } from "./conversationModel";
import type { StageInputField } from "./stageInput";
import type { AgentTargetsState } from "./useAgentTargets";
import type { WizardData } from "./useWizardData";
import type { WizardPreview } from "./useWizardPreview";
import {
  JUDGE_SAME_AGENT_HINT,
  JUDGE_SAME_HINT,
  AGENT_SAMPLE_ID,
  agentSampleAvailability,
  agentSampleError,
  agentTargetOf,
  internalTargetOf,
  estimateText,
  holdsCases,
  datasetFilePath,
  datasetFromAgentConfirm,
  datasetFromConfirm,
  datasetFromRuns,
  datasetFromSample,
  datasetFromSessions,
  datasetSummary,
  datasetTarget,
  datasetWithCases,
  defaultsErrors,
  evalFilePath,
  isAgentDraft,
  judgeSameAsStage,
  parsePercent,
  percentText,
  previewRowsOf,
  sameTarget,
  sampleCompatibility,
  setupChecks,
  targetFromRow,
  visibleFindings,
  withConversation,
  withTarget,
  withTargetKind,
  type StageRow,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

type Props = {
  data: WizardData;
  agents: AgentTargetsState;
  draft: WizardDraft;
  setDraft: (next: WizardDraft | ((d: WizardDraft) => WizardDraft)) => void;
  fields: StageInputField[] | null | undefined;
  preview: WizardPreview;
  dirs: WriteDirs;
};

type Dialog =
  | null
  | { kind: "upload"; mode: "file" | "paste" }
  | { kind: "runs" }
  | { kind: "sessions" }
  | { kind: "scenario"; index: number | null };

const TILE = "flex flex-col gap-1 rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-50";

export function SetupStep({ data, agents, draft, setDraft, fields, preview, dirs }: Props) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const taken = useMemo(() => ({ evals: data.evals.map((e) => e.id), datasets: data.datasets.map((d) => d.id) }), [data]);
  const errors = defaultsErrors(draft.defaults);
  const agent = isAgentDraft(draft);
  const t = draft.target;
  const selectedRow = data.rows.find((r) => sameTarget(r, t)) ?? null;
  const selectedAgent = agent && t ? (agents.items.find((a) => a.id === t.agentId) ?? null) : null;
  const known = fields ?? null;
  const sample = agent ? agentSampleAvailability() : sampleCompatibility(fields === undefined ? null : known);
  const ds = draft.dataset;

  async function installAgentSample() {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const out = await installEvalSample(t?.projectRoot, "agent");
      navigate(evalRoute(out.eval_id, { openRun: true }));
    } catch (err) {
      const code = err instanceof EvalApiError ? err.code : "";
      showToast(agentSampleError(code, err instanceof Error ? err.message : String(err)));
      if (code === "SAMPLE_EXISTS") navigate(evalRoute(AGENT_SAMPLE_ID, { openRun: true }));
    } finally {
      setSampleBusy(false);
    }
  }
  const stageId = t?.stageId ?? (agent ? "agent" : "stage");
  const judgeModels = data.models.filter((m) => countsAsJudgeModel(m));
  const judgeIds = judgeModels.map((m) => m.id);
  const hint = judgeSameAsStage(draft);
  const mode = draft.conversation.mode;
  const heldCases: EvalCaseInput[] = ds?.cases ?? [];

  function pick(row: StageRow, pipelinePath?: string) {
    if (row.readOnly) return;
    const next = targetFromRow(row, pipelinePath !== undefined ? { pipelinePath } : {});
    setDraft((d) => withTarget(d, next, null, taken.evals));
  }

  function confirmUpload(req: UploadConfirm) {
    const source = dialog?.kind === "upload" && dialog.mode === "paste" ? "paste" : "upload";
    setDraft((d) => ({
      ...d,
      dataset: agent ? datasetFromAgentConfirm(req, source, stageId, taken.datasets, d.conversation.mode) : datasetFromConfirm(req, source, stageId, taken.datasets),
    }));
    setDialog(null);
  }

  function saveScenario(index: number | null, scenario: EvalCaseInput & { id: string }) {
    setDraft((d) => {
      const current = d.dataset?.cases ?? [];
      const next = index === null ? [...current, scenario] : current.map((c, i) => (i === index ? scenario : c));
      return { ...d, dataset: datasetWithCases(d.dataset, next, d.conversation.mode, stageId, taken.datasets) };
    });
    setDialog(null);
  }

  function removeScenario(index: number) {
    setDraft((d) => ({
      ...d,
      dataset: datasetWithCases(d.dataset, (d.dataset?.cases ?? []).filter((_, i) => i !== index), d.conversation.mode, stageId, taken.datasets),
    }));
  }

  const findings = visibleFindings(preview.findings, holdsCases(draft));
  const checks = setupChecks(draft, findings);
  const evalPath = evalFilePath(dirs, draft.id);
  const toolIds = (selectedAgent?.tools ?? []).map((x) => x.id);
  const targetNoun = agent ? "agent" : "stage";
  const unitNoun = agent ? "scenarios" : "cases";
  const userModelFinding = findings.find((f) => f.code === "eval.simulator_unsupported");
  const userModelWarning = findings.find((f) => f.code === "eval.simulator_same_as_agent");
  const estimateLines = agent ? agentEstimateLines(preview.estimate) : [];
  const basis = agent ? estimateBasisText(preview.estimate) : null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-6 overflow-y-auto px-7 py-5">
      <div className="flex min-w-0 flex-col gap-4">
        <Section
          n={1}
          title="Target"
          hint="What do you want to check?"
          right={
            <span className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5 text-xs" role="radiogroup" aria-label="Target kind">
              {(
                [
                  ["stage", "Stage"],
                  ["agent", "Agent"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.targetKind === kind}
                  onClick={() => setDraft((d) => withTargetKind(d, kind))}
                  className={`rounded-md px-2.5 py-1 ${draft.targetKind === kind ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
                >
                  {label}
                </button>
              ))}
            </span>
          }
        >
          {agent ? (
            <>
              <AgentPicker
                items={agents.items}
                loading={agents.loading}
                error={agents.error}
                target={t}
                onRetry={agents.reload}
                onPick={(a) => setDraft((d) => withTarget(d, agentTargetOf(a, d.target?.projectRoot), null, taken.evals))}
                onPickInternal={(a) => setDraft((d) => withTarget(d, internalTargetOf(a), null, taken.evals))}
              />
              {selectedAgent ? (
                <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>tools</span>
                    <RiskBadges badges={riskBadges(selectedAgent.tools)} />
                    <span className="ml-auto text-xs text-[var(--sf-text-3)]">{toolSummary(selectedAgent.tools)}</span>
                  </div>
                  {draft.conversation.tools === "read_only" ? (
                    <p className="text-xs text-[var(--sf-text-3)]">{stubbedHint(selectedAgent.tools, draft.conversation.readOnlyTools)}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
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
            </>
          )}
        </Section>

        <Section n={2} title="Dataset" hint={agent ? "The scenarios the agent will be run on" : "The cases the stage will be run on"}>
          <div className="grid grid-cols-4 gap-3">
            <button type="button" disabled={!t} onClick={() => setDialog({ kind: "upload", mode: "file" })} className={`${TILE} ${ds?.source === "upload" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
              <LuUpload className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Upload a file</span>
              <span className="text-xs text-[var(--sf-text-3)]">JSONL, JSON or CSV</span>
            </button>
            {agent ? (
              <button type="button" disabled={!t} onClick={() => setDialog({ kind: "scenario", index: null })} className={`${TILE} ${ds?.source === "paste" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
                <LuPencil className="size-4" aria-hidden />
                <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Write scenarios</span>
                <span className="text-xs text-[var(--sf-text-3)]">Script or simulated user</span>
              </button>
            ) : (
              <button type="button" disabled={!t} onClick={() => setDialog({ kind: "upload", mode: "paste" })} className={`${TILE} ${ds?.source === "paste" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}>
                <LuClipboardList className="size-4" aria-hidden />
                <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Paste or type</span>
                <span className="text-xs text-[var(--sf-text-3)]">Add cases in a table</span>
              </button>
            )}
            <button
              type="button"
              disabled={!t}
              onClick={() => setDialog({ kind: agent ? "sessions" : "runs" })}
              className={`${TILE} ${ds?.source === "runs" || ds?.source === "sessions" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}
            >
              <LuHistory className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{agent ? "From past sessions" : "From past runs"}</span>
              <span className="text-xs text-[var(--sf-text-3)]">{agent ? "Finished sessions of this agent" : "Pick real inputs this stage received"}</span>
            </button>
            <button
              type="button"
              disabled={!t || !sample.ok || sampleBusy}
              title={sample.ok ? undefined : sample.reason}
              onClick={() =>
                agent ? void installAgentSample() : setDraft((d) => ({ ...d, dataset: datasetFromSample(stageId, taken.datasets) }))
              }
              className={`${TILE} ${ds?.source === "sample" ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline-strong)]"}`}
            >
              <LuFlaskConical className="size-4" aria-hidden />
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Try sample data</span>
              <span className="text-xs text-[var(--sf-text-3)]">{t && !sample.ok ? sample.reason : agent ? "Installs a sample agent and 6 scenarios, then opens its eval" : "8 demo cases, no setup"}</span>
            </button>
          </div>
          {ds ? (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-[var(--sf-hairline)] px-3 py-2.5 text-[13px]">
                <LuFileText className="size-4 text-[var(--sf-text-3)]" aria-hidden />
                <span className={`${MONO} text-[var(--sf-text-1)]`}>{ds.fileName}</span>
                <span className="text-[var(--sf-text-3)]">{datasetSummary(ds, agent).title}</span>
                <span className={ds.skipped > 0 ? "text-[var(--sf-warn,#e5a50a)]" : "text-[var(--sf-pass,#3ecf8e)]"}>{datasetSummary(ds, agent).match}</span>
                <span className={`${MONO} ml-auto text-xs text-[var(--sf-text-3)]`}>{datasetFilePath(dirs, ds.name)}</span>
                <button type="button" className="text-[var(--sf-text-1)] underline-offset-2 hover:underline" onClick={() => setDialog({ kind: "upload", mode: "file" })}>Replace</button>
              </div>
              {agent && ds.cases ? (
                <ScenarioPreview
                  cases={heldCases}
                  mode={mode}
                  onAdd={() => setDialog({ kind: "scenario", index: null })}
                  onEdit={(i) => setDialog({ kind: "scenario", index: i })}
                  onRemove={removeScenario}
                />
              ) : ds.cases || ds.runPreviews.length > 0 ? (
                <PreviewTable ds={ds} fields={(fields ?? []).map((f) => f.name)} />
              ) : (
                <p className="text-xs text-[var(--sf-text-3)]">
                  {ds.source === "sessions" ? "Each session becomes a script scenario when you create the eval." : "The sample cases are copied when you create the eval."}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-[var(--sf-text-3)]">{t ? `Add the ${unitNoun} the ${targetNoun} will run on.` : `Pick ${agent ? "an agent" : "a stage"} first.`}</p>
          )}
        </Section>

        {agent ? (
          <ConversationCard
            n={3}
            value={draft.conversation}
            onChange={(next) => setDraft((d) => withConversation(d, next))}
            agentTools={selectedAgent?.tools ?? []}
            judgeModels={judgeIds}
            userModelError={userModelFinding?.message ?? null}
            userModelWarning={userModelWarning?.message ?? null}
          />
        ) : null}

        <Section n={agent ? 4 : 3} title="Run defaults" hint="You can change these for any single run">
          <div className="grid grid-cols-4 gap-3">
            <Field label="Repeats per case" hint="Models answer differently each time" error={errors.repeats}>
              <NumberField value={draft.defaults.repeats} parse={(x) => (x.trim() === "" ? null : Number(x))} show={String} error={errors.repeats} onCommit={(n) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, repeats: n } }))} />
            </Field>
            <Field label="Judge model" {...(hint ? { warn: agent ? JUDGE_SAME_AGENT_HINT : JUDGE_SAME_HINT } : {})}>
              <JudgeModelPicker
                models={
                  draft.defaults.judge && !judgeModels.some((m) => m.id === draft.defaults.judge)
                    ? [...judgeModels, { id: draft.defaults.judge }]
                    : judgeModels
                }
                value={draft.defaults.judge}
                defaultLabel="None yet"
                onChange={(judge) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, judge } }))}
              />
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
          {estimateLines.length > 0 ? (
            <dl className="mt-1 flex flex-col gap-0.5">
              {estimateLines.map((line) => (
                <div key={line.label} className="flex justify-between text-xs">
                  <dt className="text-[var(--sf-text-3)]">{line.label}</dt>
                  <dd className="text-[var(--sf-text-2)]">{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {basis ? <span className="text-xs text-[var(--sf-text-3)]">{basis}</span> : null}
          <span className="text-xs text-[var(--sf-text-3)]">The cost limit of {formatCost(draft.defaults.maxCostUsd)} still applies.</span>
        </div>
        {selectedRow?.readOnly ? <Chip tone="warn">Read-only catalog</Chip> : null}
      </aside>

      {t && dialog?.kind === "upload" ? (
        <UploadDialog
          open
          title={dialog.mode === "paste" ? "Paste or type cases" : agent ? "Upload scenarios" : "Upload cases"}
          subtitle={`For the ${t.stageId} ${targetNoun}. Nothing is written until you create the eval.`}
          target={datasetTarget(t)}
          inputFields={fields ?? []}
          initialMode={dialog.mode}
          {...(agent ? { conversationMode: mode } : {})}
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
      {t && dialog?.kind === "sessions" ? (
        <SessionCandidatesDialog
          agentId={t.agentId ?? t.stageId}
          {...(t.projectRoot ? { projectRoot: t.projectRoot } : {})}
          onClose={() => setDialog(null)}
          onConfirm={(ids, items) => {
            setDraft((d) => ({ ...d, dataset: datasetFromSessions(ids, items.map((i) => i.preview), stageId, taken.datasets) }));
            setDialog(null);
          }}
        />
      ) : null}
      {t && dialog?.kind === "scenario" ? (
        <ScenarioEditor
          initial={dialog.index === null ? null : ((heldCases[dialog.index] as (EvalCaseInput & { id: string }) | undefined) ?? null)}
          defaultMode={mode}
          existingIds={heldCases.map((c, i) => c.id ?? `c${String(i + 1).padStart(3, "0")}`)}
          toolIds={toolIds}
          onClose={() => setDialog(null)}
          onSave={(c) => saveScenario(dialog.index, c)}
        />
      ) : null}
    </div>
  );
}

function ScenarioPreview({
  cases,
  mode,
  onAdd,
  onEdit,
  onRemove,
}: {
  cases: EvalCaseInput[];
  mode: WizardDraft["conversation"]["mode"];
  onAdd: () => void;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const rows = cases.slice(0, 50).map((c, i) => scenarioRow(c, mode, i));
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)] text-xs">
        <div className="grid grid-cols-[32px_84px_minmax(0,1fr)_minmax(0,1.6fr)_52px] gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2 text-[var(--sf-text-3)]">
          <span>#</span>
          <span>Mode</span>
          <span>Title</span>
          <span>Opening or first message</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={`${r.id}:${i}`} className="grid grid-cols-[32px_84px_minmax(0,1fr)_minmax(0,1.6fr)_52px] items-start gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2 last:border-b-0">
            <span className="text-[var(--sf-text-3)]">{i + 1}</span>
            <span className="text-[var(--sf-text-2)]">{modeLabel(r.mode)}</span>
            <span className="line-clamp-2 break-words text-[var(--sf-text-1)]">{r.title || r.id}</span>
            <span className={`${MONO} line-clamp-2 break-words text-[var(--sf-text-2)]`}>{r.opening}</span>
            <span className="flex gap-1">
              <button type="button" aria-label={`Edit scenario ${i + 1}`} onClick={() => onEdit(i)} className="flex size-5 items-center justify-center rounded text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]">
                <LuPencil className="size-3.5" aria-hidden />
              </button>
              <button type="button" aria-label={`Remove scenario ${i + 1}`} onClick={() => onRemove(i)} className="flex size-5 items-center justify-center rounded text-[var(--sf-text-3)] hover:text-[var(--sf-fail)]">
                <LuTrash2 className="size-3.5" aria-hidden />
              </button>
            </span>
          </div>
        ))}
      </div>
      <button type="button" onClick={onAdd} className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)]">
        <LuPlus className="size-3.5" aria-hidden /> Add scenario
      </button>
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
