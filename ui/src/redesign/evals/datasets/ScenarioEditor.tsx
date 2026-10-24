import { useMemo, useState } from "react";
import { LuArrowDown, LuArrowUp, LuPlus, LuTrash2 } from "react-icons/lu";
import type { EvalCaseInput, EvalConversationMode } from "../../../api/evalTypes";
import { ChipInput } from "../newEval/ChipInput";
import { Field } from "../newEval/parts";
import { BTN, BTN_PRIMARY, DialogShell, INPUT, MONO, TEXTAREA } from "./DialogShell";
import {
  FACTS_MAX_ITEMS,
  IGNORED_TITLE,
  SCRIPT_MAX_ITEMS,
  emptyScenario,
  ignoredFields,
  modeLabel,
  moveItem,
  scenarioFromCase,
  scenarioToCase,
  type MockRow,
  type ScenarioDraft,
} from "./scenarioModel";

type Props = {
  /** The scenario being edited; omit to add one. */
  initial?: (EvalCaseInput & { id: string }) | null;
  defaultMode: EvalConversationMode;
  existingIds: readonly string[];
  /** Tool ids the agent has, offered as suggestions and used to flag unknown names. */
  toolIds?: readonly string[];
  onClose: () => void;
  onSave: (c: EvalCaseInput & { id: string }) => void | Promise<void>;
};

const IGNORED_LABELS: Record<string, string> = { opening: "Opening", persona: "Persona", goal: "Goal", facts: "Facts", script: "Script" };

function ListEditor({
  values,
  onChange,
  label,
  max,
  placeholder,
  reorder = false,
  error,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  label: string;
  max: number;
  placeholder?: string;
  reorder?: boolean;
  error?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="mt-2 w-5 shrink-0 text-right text-xs text-[var(--sf-text-3)]">{i + 1}</span>
          <textarea
            aria-label={`${label} ${i + 1}`}
            className={`${TEXTAREA} min-h-[34px] flex-1`}
            rows={1}
            value={v}
            placeholder={placeholder}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          {reorder ? (
            <>
              <button type="button" aria-label={`Move ${label} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveItem(values, i, i - 1))} className="mt-1 flex size-6 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] disabled:opacity-30">
                <LuArrowUp className="size-3.5" aria-hidden />
              </button>
              <button type="button" aria-label={`Move ${label} ${i + 1} down`} disabled={i === values.length - 1} onClick={() => onChange(moveItem(values, i, i + 1))} className="mt-1 flex size-6 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] disabled:opacity-30">
                <LuArrowDown className="size-3.5" aria-hidden />
              </button>
            </>
          ) : null}
          <button type="button" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(values.filter((_, j) => j !== i))} className="mt-1 flex size-6 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-fail)]">
            <LuTrash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button type="button" disabled={values.length >= max} onClick={() => onChange([...values, ""])} className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)] disabled:opacity-40">
          <LuPlus className="size-3.5" aria-hidden /> Add {label.toLowerCase()}
        </button>
        {error ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{error}</span> : null}
      </div>
    </div>
  );
}

function MocksTable({ rows, onChange, errors, toolIds }: { rows: MockRow[]; onChange: (next: MockRow[]) => void; errors: Record<string, string>; toolIds: readonly string[] }) {
  const patch = (i: number, p: Partial<MockRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="grid grid-cols-[minmax(0,1fr)_96px_minmax(0,1.4fr)_28px] items-center gap-2">
            <input aria-label={`Mock tool ${i + 1}`} list="scenario-tool-ids" className={`${INPUT} ${MONO}`} value={row.tool} placeholder="billing.lookup_invoice" onChange={(e) => patch(i, { tool: e.target.value })} />
            <select aria-label={`Mock kind ${i + 1}`} className={INPUT} value={row.kind} onChange={(e) => patch(i, { kind: e.target.value as MockRow["kind"] })}>
              <option value="result">Result</option>
              <option value="error">Error</option>
            </select>
            <input aria-label={`Mock value ${i + 1}`} className={`${INPUT} ${row.kind === "result" ? MONO : ""}`} value={row.text} placeholder={row.kind === "result" ? '{"status":"duplicate"}' : "Error text"} onChange={(e) => patch(i, { text: e.target.value })} />
            <button type="button" aria-label={`Remove mock ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="flex size-7 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-fail)]">
              <LuTrash2 className="size-3.5" aria-hidden />
            </button>
          </div>
          {errors[`mock.${i}.tool`] ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors[`mock.${i}.tool`]}</span> : null}
          {errors[`mock.${i}.value`] ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors[`mock.${i}.value`]}</span> : null}
          {row.tool.trim() !== "" && toolIds.length > 0 && !toolIds.includes(row.tool.trim()) ? (
            <span className="text-xs text-[var(--sf-warn,#e5a50a)]">The agent is not granted {row.tool.trim()} (eval.tool_not_granted).</span>
          ) : null}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { tool: "", kind: "result", text: "" }])} className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)]">
        <LuPlus className="size-3.5" aria-hidden /> Add mock
      </button>
      <datalist id="scenario-tool-ids">
        {toolIds.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

export function ScenarioEditor({ initial = null, defaultMode, existingIds, toolIds = [], onClose, onSave }: Props) {
  const [draft, setDraft] = useState<ScenarioDraft>(() => (initial ? scenarioFromCase(initial, defaultMode) : emptyScenario(defaultMode, existingIds)));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const result = useMemo(() => scenarioToCase(draft, { defaultMode, existingIds, editing: initial !== null }), [draft, defaultMode, existingIds, initial]);
  const errors = result.ok ? {} : result.errors;
  const shown = (key: string) => (dirty ? errors[key] : undefined);
  const ignored = ignoredFields(draft.mode);
  const set = (patch: Partial<ScenarioDraft>) => {
    setDirty(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const simulated = draft.mode === "simulated";

  async function save() {
    setDirty(true);
    if (!result.ok) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(result.case);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <DialogShell
      title={initial ? "Edit scenario" : "Add scenario"}
      subtitle="A scripted or simulated user, and what the agent should do."
      width="w-[760px]"
      onClose={onClose}
      footer={
        <>
          <span role={failure ? "alert" : undefined} className="text-xs text-[var(--sf-fail)]">{failure}</span>
          <span className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy || !result.ok} onClick={() => void save()}>
              {initial ? "Save scenario" : "Add scenario"}
            </button>
          </span>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
          <span>Mode</span>
          <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5" role="radiogroup" aria-label="Scenario mode">
            {(["script", "simulated"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={draft.mode === m} onClick={() => set({ mode: m })} className={`h-7 flex-1 rounded-md text-[13px] ${draft.mode === m ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}>
                {modeLabel(m)}
              </button>
            ))}
          </div>
          <span className="text-xs text-[var(--sf-text-3)]">{draft.mode === defaultMode ? `Same as the eval (${modeLabel(defaultMode)}).` : `Overrides the eval's ${modeLabel(defaultMode)} mode for this scenario.`}</span>
        </div>
        <Field label="Title" error={shown("title")}>
          <input className={INPUT} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Tags" error={shown("tags")} hint="Separated by spaces">
          <input className={`${INPUT} ${MONO}`} value={draft.tags} onChange={(e) => set({ tags: e.target.value })} />
        </Field>
      </div>

      {simulated ? (
        <>
          <Field label="Opening" error={shown("opening")} hint="The first user message, sent as written.">
            <textarea className={`${TEXTAREA} min-h-[56px]`} value={draft.opening} onChange={(e) => set({ opening: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Persona" error={shown("persona")} hint="Who the user is and how they write.">
              <textarea className={`${TEXTAREA} min-h-[56px]`} value={draft.persona} onChange={(e) => set({ persona: e.target.value })} />
            </Field>
            <Field label="Goal" error={shown("goal")} hint="What the user wants to achieve.">
              <textarea className={`${TEXTAREA} min-h-[56px]`} value={draft.goal} onChange={(e) => set({ goal: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
            <span>Facts <span className="text-xs text-[var(--sf-text-3)]">things the user knows and reveals when asked</span></span>
            <ListEditor values={draft.facts} onChange={(facts) => set({ facts })} label="Fact" max={FACTS_MAX_ITEMS} error={shown("facts")} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
          <span>Script messages <span className="text-xs text-[var(--sf-text-3)]">the user messages, in order</span></span>
          <ListEditor values={draft.script} onChange={(script) => set({ script })} label="Message" max={SCRIPT_MAX_ITEMS} reorder placeholder="What the user says" error={shown("script")} />
        </div>
      )}

      <details className="rounded-lg border border-[var(--sf-hairline)] px-3 py-2 text-xs text-[var(--sf-text-3)]">
        <summary className="cursor-pointer text-[var(--sf-text-2)]">{IGNORED_TITLE}</summary>
        <p className="pt-1.5">{ignored.map((f) => IGNORED_LABELS[f]).join(", ")} {ignored.length === 1 ? "is" : "are"} not used when this scenario is {draft.mode}. Anything already saved there is kept.</p>
      </details>

      <section className="flex flex-col gap-3 border-t border-t-[var(--sf-hairline)] pt-3" aria-label="Expected">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Expected</h3>
        <Field label="Outcome" error={shown("outcome")} hint="What a good conversation ends with. Used by goal and rubric graders.">
          <textarea className={`${TEXTAREA} min-h-[44px]`} value={draft.outcome} onChange={(e) => set({ outcome: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
            <span>Tools</span>
            <ChipInput values={draft.tools} onChange={(tools) => set({ tools })} label="Expected tool" placeholder="billing.lookup_invoice" suggestions={toolIds} flag={(v) => toolIds.length > 0 && !v.endsWith(".*") && !toolIds.includes(v)} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
            <span>Forbidden tools</span>
            <ChipInput values={draft.forbiddenTools} onChange={(forbiddenTools) => set({ forbiddenTools })} label="Forbidden tool" placeholder="billing.refund" suggestions={toolIds} flag={(v) => toolIds.length > 0 && !v.endsWith(".*") && !toolIds.includes(v)} />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-t-[var(--sf-hairline)] pt-3" aria-label="Tool mocks">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Tool mocks</h3>
        <p className="text-xs text-[var(--sf-text-3)]">Canned results for tools that would otherwise be stubbed. Used by Read only and Mocked tools.</p>
        <MocksTable rows={draft.mocks} onChange={(mocks) => set({ mocks })} errors={dirty ? errors : {}} toolIds={toolIds} />
        {shown("mocks") ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{shown("mocks")}</span> : null}
      </section>
    </DialogShell>
  );
}
