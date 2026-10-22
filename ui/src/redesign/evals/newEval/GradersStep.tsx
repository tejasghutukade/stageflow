import { useRef, useState } from "react";
import { LuCheck, LuChevronDown, LuLoader, LuPlay, LuPlus, LuX } from "react-icons/lu";
import { tryEvalCase } from "../../../api/evalsClient";
import type { EvalAgentTool, EvalTryResult } from "../../../api/evalTypes";
import { HeaderChips, TranscriptList } from "../results/TranscriptView";
import { errorLabel, transcriptView } from "../results/transcriptModel";
import type { ValidationFinding } from "../../../api/types";
import { INPUT } from "../datasets/DialogShell";
import { formatCost, formatDuration, formatPercent, formatScore } from "../format";
import { GraderCard } from "./GraderCard";
import { MAX_GRADERS, graderTypesFor, type GraderTarget, type GraderType } from "./graderForms";
import { CARD, MONO, SELECT } from "./parts";
import {
  addGrader,
  budgetLabel,
  buildDefinition,
  caseVerdictText,
  isAgentDraft,
  moveGrader,
  parseBudgetInput,
  removeGrader,
  renameGrader,
  replaceGrader,
  setBudget,
  tryCaseLabel,
  tryCaseOf,
  tryDisabledReason,
  type GradersDraft,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

type Props = {
  draft: WizardDraft;
  setDraft: (next: WizardDraft | ((d: WizardDraft) => WizardDraft)) => void;
  dirs: WriteDirs;
  findings: ValidationFinding[];
  judgeModels: string[];
  agentTools?: EvalAgentTool[];
};

const TYPES_PANEL: Array<[string, string]> = [
  ["Schema", "output fits io.output"],
  ["Field check", "equals, contains, regex, range"],
  ["Reference match", "compare with expected"],
  ["Rubric", "a model judges the output"],
  ["Custom code", "JavaScript, returns a score"],
];

const AGENT_TYPES_PANEL: Array<[string, string]> = [
  ["Field check", "checks on the final reply or turns"],
  ["Reference match", "compare with expected"],
  ["Rubric", "a model judges the conversation"],
  ["Custom code", "JavaScript, returns a score"],
  ["Tool calls", "which tools ran, with what"],
  ["Conversation check", "turns, questions, final reply"],
  ["Goal reached", "a model judges the goal"],
];

type SetDraft<T> = (next: T | ((d: T) => T)) => void;

function BudgetChip<T extends GradersDraft>({ draft, field, setDraft }: { draft: T; field: "latency_ms" | "cost_usd"; setDraft: SetDraft<T> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const unit = field === "latency_ms" ? "seconds" : "USD";
  if (!editing) {
    return (
      <button
        type="button"
        className={`${MONO} rounded border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-1 text-xs text-[var(--sf-text-1)]`}
        onClick={() => {
          const v = draft.budget?.[field];
          setText(v === undefined ? "" : String(field === "latency_ms" ? v / 1000 : v));
          setError(null);
          setEditing(true);
        }}
      >
        {budgetLabel(field, draft.budget?.[field])}
      </button>
    );
  }
  function commit() {
    const parsed = parseBudgetInput(text, field);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setDraft((d) => setBudget(d, field, parsed.value));
    setEditing(false);
  }
  return (
    <span className="flex items-center gap-1.5">
      <input
        autoFocus
        className={`${INPUT} ${MONO} h-7 w-24 text-xs`}
        value={text}
        placeholder={unit}
        aria-label={`${field === "latency_ms" ? "Latency" : "Cost"} budget in ${unit}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={commit}
      />
      <span className="text-xs text-[var(--sf-text-3)]">{unit}</span>
      {error ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{error}</span> : null}
    </span>
  );
}

type TryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "cancelled" }
  | { status: "done"; result: EvalTryResult }
  | { status: "error"; message: string };

function TryPanel({ draft, dirs, findings }: { draft: WizardDraft; dirs: WriteDirs; findings: ValidationFinding[] }) {
  const cases = draft.dataset?.cases ?? [];
  const agent = isAgentDraft(draft);
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<TryState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const blocked = tryDisabledReason(draft, findings);
  const chosen = cases[Math.min(index, Math.max(cases.length - 1, 0))];

  async function run() {
    const definition = buildDefinition(draft, dirs);
    if (!definition || !chosen) return;
    const abort = new AbortController();
    controller.current = abort;
    setState({ status: "running" });
    try {
      const root = draft.target?.projectRoot;
      const consent = agent && draft.conversation.tools === "real" && draft.conversation.allowReal;
      const result = await tryEvalCase(
        {
          definition,
          case: tryCaseOf(chosen, index),
          dataset_cases: cases,
          ...(root ? { project_root: root } : {}),
          ...(consent ? { allow_real_tools: true } : {}),
        },
        abort.signal,
      );
      if (!abort.signal.aborted) setState({ status: "done", result });
    } catch (err) {
      if (abort.signal.aborted) return;
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setState({ status: "cancelled" });
  }

  const result = state.status === "done" ? state.result.result : null;
  const output = result?.output as { summary?: unknown } | null | undefined;
  const view = agent && result ? transcriptView(result) : null;
  return (
    <section className={`${CARD} flex flex-col gap-3 p-3.5`} aria-label="Try on one case">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-[var(--sf-text-1)]">Try on one case</h2>
        {state.status === "running" ? (
          <span className="rounded bg-[var(--sf-running-bg)] px-1.5 py-px text-[11px] text-[var(--sf-running)]">Running</span>
        ) : null}
        {state.status === "done" ? <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>{formatCost(state.result.cost_usd)}</span> : null}
      </div>
      <div className="flex gap-2">
        <select className={SELECT} value={index} disabled={cases.length === 0 || state.status === "running"} onChange={(e) => setIndex(Number(e.target.value))} aria-label={agent ? "Scenario" : "Case"}>
          {cases.length === 0 ? <option>{agent ? "No scenarios in hand" : "No cases in hand"}</option> : null}
          {cases.map((c, i) => (
            <option key={i} value={i}>{tryCaseLabel(c, i)}</option>
          ))}
        </select>
        {state.status === "running" ? (
          <button type="button" onClick={cancel} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]">
            <LuLoader className="size-3.5 animate-spin" aria-hidden />
            Cancel
          </button>
        ) : (
          <button type="button" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => void run()} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-50">
            <LuPlay className="size-3.5" aria-hidden />
            Run
          </button>
        )}
      </div>
      {blocked ? <p className="text-xs text-[var(--sf-text-3)]">{blocked}</p> : null}
      {state.status === "running" ? (
        <p className="text-xs text-[var(--sf-text-3)]">
          {agent ? "Running the conversation and grading it. This can take a minute." : "Running the stage and grading the output…"}
        </p>
      ) : null}
      {state.status === "cancelled" ? <p className="text-xs text-[var(--sf-text-3)]">Cancelled. Nothing was kept.</p> : null}
      {state.status === "error" ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{state.message}</p> : null}
      {result ? (
        <div className="flex flex-col gap-2">
          {agent && view ? (
            <div className="flex flex-col gap-3">
              <HeaderChips view={view} />
              <div className="max-h-[420px] overflow-y-auto">
                <TranscriptList view={view} />
              </div>
            </div>
          ) : null}
          {result.status !== "completed" ? (
            <p role="alert" className="text-xs text-[var(--sf-fail)]">
              {errorLabel(result.error_code) ? <strong className="mr-1.5">{errorLabel(result.error_code)}</strong> : null}
              {result.error_message ?? result.error_code ?? (agent ? "The conversation did not finish." : "The stage did not finish.")}
            </p>
          ) : (
            <>
              {agent ? (
                <div className={`${MONO} flex justify-end text-xs text-[var(--sf-text-3)]`}>{formatDuration(result.latency_ms)} · {formatCost(result.cost_usd)}</div>
              ) : (
                <div className="flex items-center justify-between text-xs text-[var(--sf-text-3)]">
                  <span className="truncate">Stage output: {typeof output?.summary === "string" && output.summary !== "" ? output.summary : "no summary"}</span>
                  <span className={`${MONO} shrink-0`}>{formatDuration(result.latency_ms)} · {formatCost(result.cost_usd)}</span>
                </div>
              )}
              <ul className="flex flex-col rounded-lg border border-[var(--sf-hairline)]">
                {result.grades.map((gr) => (
                  <li key={gr.grader_id} className="flex gap-2 border-b border-b-[var(--sf-hairline)] px-3 py-2 last:border-b-0">
                    {gr.passed ? <LuCheck className="mt-0.5 size-3.5 text-[var(--sf-pass,#3ecf8e)]" aria-hidden /> : <LuX className="mt-0.5 size-3.5 text-[var(--sf-fail)]" aria-hidden />}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className={`${MONO} text-xs text-[var(--sf-text-1)]`}>{gr.grader_id}</span>
                      <span className="text-xs text-[var(--sf-text-3)]">{gr.status === "error" ? (gr.error_code ?? "Grader error") : (gr.reason ?? "")}</span>
                    </div>
                    <span className={`${MONO} text-xs ${gr.passed ? "text-[var(--sf-pass,#3ecf8e)]" : "text-[var(--sf-fail)]"}`}>
                      {gr.status === "error" ? "error" : gr.score === null ? (gr.passed ? "pass" : "fail") : formatScore(gr.score)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between rounded-lg bg-[var(--sf-raised)] px-3 py-2 text-[13px]">
                <span className="text-[var(--sf-text-1)]">Case score {formatPercent(result.score)}</span>
                <span className="text-xs text-[var(--sf-text-3)]">{caseVerdictText(result.score, draft.defaults.passThreshold)}</span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function GradersList<T extends GradersDraft>({
  draft,
  setDraft,
  judgeModels,
  judgeDefault,
  target = "stage",
  agentToolIds = [],
}: {
  draft: T;
  setDraft: SetDraft<T>;
  judgeModels: string[];
  judgeDefault: string | null;
  target?: GraderTarget;
  agentToolIds?: readonly string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const ids = draft.graders.map((g) => g.id);

  function add(type: GraderType) {
    setMenu(false);
    setDraft((d) => {
      const next = addGrader(d, type);
      const created = next.graders[next.graders.length - 1];
      if (created && next !== d) setOpen(created.id);
      return next;
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold text-[var(--sf-text-1)]">
          Graders <span className="text-[13px] font-normal text-[var(--sf-text-3)]">{draft.graders.length}</span>
        </h2>
        <div className="relative">
          <button type="button" disabled={draft.graders.length >= MAX_GRADERS} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-50">
            <LuPlus className="size-3.5" aria-hidden /> Add grader <LuChevronDown className="size-3.5" aria-hidden />
          </button>
          {menu ? (
            <div role="menu" className={`${CARD} absolute right-0 top-9 z-10 flex w-72 flex-col p-1 shadow-lg`}>
              {graderTypesFor(target).map((t) => (
                <button key={t.type} type="button" role="menuitem" onClick={() => add(t.type)} className="flex flex-col rounded-md px-3 py-2 text-left hover:bg-[var(--sf-raised)]">
                  <span className="flex items-center gap-2 text-[13px] text-[var(--sf-text-1)]">
                    {t.label}
                    {t.agent ? <span className="rounded bg-[var(--sf-raised)] px-1.5 text-[10px] text-[var(--sf-text-3)]">agent</span> : null}
                  </span>
                  <span className="text-xs text-[var(--sf-text-3)]">{t.summary}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {draft.graders.length === 0 ? (
        <div className={`${CARD} p-6 text-center text-[13px] text-[var(--sf-text-2)]`}>No graders yet. Add at least one to decide what a good result looks like.</div>
      ) : null}

      {draft.graders.map((g, i) => (
        <GraderCard
          key={g.id}
          grader={g}
          otherIds={ids.filter((_, j) => j !== i)}
          judgeModels={judgeModels}
          judgeDefault={judgeDefault}
          isAgent={target === "agent"}
          agentToolIds={agentToolIds}
          expanded={open === g.id}
          dragging={dragFrom === i}
          onToggle={() => setOpen(open === g.id ? null : g.id)}
          onChange={(next) => setDraft((d) => replaceGrader(d, i, next))}
          onRename={(id) => {
            setDraft((d) => renameGrader(d, i, id));
            setOpen(id);
          }}
          onRemove={() => setDraft((d) => removeGrader(d, i))}
          onMove={(delta) => setDraft((d) => moveGrader(d, i, i + delta))}
          dragHandlers={{
            onDragStart: () => setDragFrom(i),
            onDragOver: (e) => e.preventDefault(),
            onDrop: () => {
              if (dragFrom !== null) setDraft((d) => moveGrader(d, dragFrom, i));
              setDragFrom(null);
            },
            onDragEnd: () => setDragFrom(null),
          }}
        />
      ))}

      <div className={`${CARD} flex flex-wrap items-center gap-3 px-3.5 py-3`}>
        <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Budget</span>
        <BudgetChip draft={draft} field="latency_ms" setDraft={setDraft} />
        <BudgetChip draft={draft} field="cost_usd" setDraft={setDraft} />
        <span className="ml-auto text-xs text-[var(--sf-text-3)]">Reported as warnings, they do not fail a case</span>
      </div>
    </div>
  );
}

export function GradersStep({ draft, setDraft, dirs, findings, judgeModels, agentTools = [] }: Props) {
  const agent = isAgentDraft(draft);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-6 overflow-y-auto px-7 py-5">
      <GradersList
        draft={draft}
        setDraft={setDraft}
        judgeModels={judgeModels}
        judgeDefault={draft.defaults.judge}
        target={agent ? "agent" : "stage"}
        agentToolIds={agentTools.map((t) => t.id)}
      />

      <aside className="flex min-w-0 flex-col gap-3">
        <TryPanel draft={draft} dirs={dirs} findings={findings} />
        <section className={`${CARD} flex flex-col gap-2 p-3.5`} aria-label="Grader types">
          <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Grader types</span>
          {(agent ? AGENT_TYPES_PANEL : TYPES_PANEL).map(([name, what]) => (
            <div key={name} className="flex items-center justify-between text-[13px]">
              <span className="text-[var(--sf-text-1)]">{name}</span>
              <span className="text-xs text-[var(--sf-text-3)]">{what}</span>
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}
