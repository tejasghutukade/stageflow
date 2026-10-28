import { useState } from "react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { INPUT, TEXTAREA } from "../datasets/DialogShell";
import { ChipInput } from "./ChipInput";
import { JudgeSettingsFields } from "./JudgeSettingsFields";
import { Field, MONO, SELECT } from "./parts";
import {
  FIELD_OPS,
  GOAL_REACHED_NOTE,
  GUIDANCE_MAX,
  MAX_ARGS_ROWS,
  MAX_CALLS_LIMIT,
  MAX_FINAL_REPLY_ROWS,
  TOOL_CALLS_HELPER,
  argToRow,
  argsOf,
  finalReplyOf,
  finalReplyToRow,
  opNeedsValue,
  rowToArg,
  rowToFinalReply,
  setArgs,
  setFinalReply,
  setJudge,
  setOptionalInt,
  setStringList,
  stringList,
  ungrantedToolNames,
  type GraderConfig,
  type ToolArgRow,
  type FinalReplyRow,
} from "./graderForms";

type FormProps = { grader: GraderConfig; onChange: (next: GraderConfig) => void };

function IntField({
  label,
  grader,
  keyName,
  range,
  placeholder,
  onChange,
}: FormProps & { label: string; keyName: "max_calls" | "max_turns" | "max_agent_questions_per_turn"; range: { min: number; max: number }; placeholder: string }) {
  const [text, setText] = useState(grader[keyName] === undefined ? "" : String(grader[keyName]));
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} error={error ?? undefined}>
      <input
        className={INPUT}
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const res = setOptionalInt(grader, keyName, e.target.value, range);
          if (res.ok) {
            setError(null);
            onChange(res.grader);
          } else setError(res.error);
        }}
      />
    </Field>
  );
}

function OpValueRow({
  op,
  valueText,
  onOp,
  onValue,
  leading,
  onRemove,
  removeLabel,
}: {
  op: string;
  valueText: string;
  onOp: (op: string) => void;
  onValue: (text: string) => void;
  leading?: React.ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <>
      {leading}
      <select className={SELECT} value={op} onChange={(e) => onOp(e.target.value)} aria-label="Operator">
        {FIELD_OPS.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <input className={`${INPUT} ${MONO}`} value={valueText} disabled={!opNeedsValue(op)} onChange={(e) => onValue(e.target.value)} aria-label="Value" placeholder={opNeedsValue(op) ? "value" : ""} />
      <button type="button" aria-label={removeLabel} onClick={onRemove} className="flex size-7 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)]">
        <LuTrash2 className="size-3.5" aria-hidden />
      </button>
    </>
  );
}

export function ToolCallsForm({ grader, onChange, toolIds }: FormProps & { toolIds: readonly string[] }) {
  const [rows, setRows] = useState<ToolArgRow[]>(() => argsOf(grader).map(argToRow));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const missing = new Set(ungrantedToolNames(grader, toolIds));
  const flag = toolIds.length > 0 ? (name: string) => missing.has(name) : undefined;

  function edit(i: number, patch: Partial<ToolArgRow>) {
    const row = { ...(rows[i] as ToolArgRow), ...patch };
    const nextRows = rows.map((r, j) => (j === i ? row : r));
    setRows(nextRows);
    const parsed = rowToArg(row);
    setErrors((e) => {
      const { [i]: _drop, ...rest } = e;
      void _drop;
      return parsed.ok ? rest : { ...rest, [i]: parsed.error };
    });
    const valid = nextRows.map(rowToArg).filter((p): p is Extract<ReturnType<typeof rowToArg>, { ok: true }> => p.ok);
    onChange(setArgs(grader, valid.map((p) => p.arg)));
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--sf-text-3)]">{TOOL_CALLS_HELPER}</p>
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ["must_call", "Must call"],
            ["must_not_call", "Must not call"],
            ["must_ask_first", "Must ask first"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
            <span>{label}</span>
            <ChipInput values={stringList(grader, key)} onChange={(list) => onChange(setStringList(grader, key, list))} label={label} placeholder="tool id" suggestions={toolIds} {...(flag ? { flag } : {})} />
          </div>
        ))}
      </div>
      {missing.size > 0 ? (
        <p className="text-xs text-[var(--sf-warn,#e5a50a)]">
          The agent is not granted {[...missing].join(", ")}. A tool it does not have can never be called (eval.tool_not_granted).
        </p>
      ) : null}
      <div className="w-40">
        <IntField label="Max calls" grader={grader} keyName="max_calls" range={{ min: 0, max: MAX_CALLS_LIMIT }} placeholder="no limit" onChange={onChange} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-[var(--sf-text-2)]">Arguments <span className="text-xs text-[var(--sf-text-3)]">every call to the tool must satisfy the check</span></span>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_120px_minmax(0,1fr)_28px] items-center gap-2">
              <OpValueRow
                op={row.op}
                valueText={row.valueText}
                onOp={(op) => edit(i, { op })}
                onValue={(valueText) => edit(i, { valueText })}
                leading={
                  <>
                    <input className={`${INPUT} ${MONO}`} value={row.tool} onChange={(e) => edit(i, { tool: e.target.value })} aria-label="Tool" placeholder="billing.lookup_invoice" list="agent-tool-ids" />
                    <input className={`${INPUT} ${MONO}`} value={row.path} onChange={(e) => edit(i, { path: e.target.value })} aria-label="Argument path" placeholder="invoice_id" />
                  </>
                }
                onRemove={() => {
                  const nextRows = rows.filter((_, j) => j !== i);
                  setRows(nextRows);
                  setErrors({});
                  const valid = nextRows.map(rowToArg).filter((p): p is Extract<ReturnType<typeof rowToArg>, { ok: true }> => p.ok);
                  onChange(setArgs(grader, valid.map((p) => p.arg)));
                }}
                removeLabel="Remove argument check"
              />
            </div>
            {errors[i] ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors[i]}</span> : null}
          </div>
        ))}
        <datalist id="agent-tool-ids">
          {toolIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          type="button"
          disabled={rows.length >= MAX_ARGS_ROWS}
          className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)] disabled:opacity-40"
          onClick={() => setRows([...rows, { tool: "", path: "", op: "exists", valueText: "" }])}
        >
          <LuPlus className="size-3.5" aria-hidden /> Add argument check
        </button>
      </div>
    </div>
  );
}

export function ConversationCheckForm({ grader, onChange }: FormProps) {
  const [rows, setRows] = useState<FinalReplyRow[]>(() => finalReplyOf(grader).map(finalReplyToRow));
  const [errors, setErrors] = useState<Record<number, string>>({});

  function commit(nextRows: FinalReplyRow[]) {
    const valid = nextRows.map(rowToFinalReply).filter((p): p is Extract<ReturnType<typeof rowToFinalReply>, { ok: true }> => p.ok);
    onChange(setFinalReply(grader, valid.map((p) => p.check)));
  }

  function edit(i: number, patch: Partial<FinalReplyRow>) {
    const row = { ...(rows[i] as FinalReplyRow), ...patch };
    const nextRows = rows.map((r, j) => (j === i ? row : r));
    setRows(nextRows);
    const parsed = rowToFinalReply(row);
    setErrors((e) => {
      const { [i]: _drop, ...rest } = e;
      void _drop;
      return parsed.ok ? rest : { ...rest, [i]: parsed.error };
    });
    commit(nextRows);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <IntField label="Max turns" grader={grader} keyName="max_turns" range={{ min: 1, max: 100 }} placeholder="no limit" onChange={onChange} />
        <IntField label="Max questions per agent turn" grader={grader} keyName="max_agent_questions_per_turn" range={{ min: 0, max: 10 }} placeholder="no limit" onChange={onChange} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-[var(--sf-text-2)]">Final reply checks <span className="text-xs text-[var(--sf-text-3)]">all must hold</span></span>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="grid grid-cols-[130px_minmax(0,1fr)_28px] items-center gap-2">
              <OpValueRow
                op={row.op}
                valueText={row.valueText}
                onOp={(op) => edit(i, { op })}
                onValue={(valueText) => edit(i, { valueText })}
                onRemove={() => {
                  const nextRows = rows.filter((_, j) => j !== i);
                  setRows(nextRows);
                  setErrors({});
                  commit(nextRows);
                }}
                removeLabel="Remove final reply check"
              />
            </div>
            {errors[i] ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors[i]}</span> : null}
          </div>
        ))}
        <button
          type="button"
          disabled={rows.length >= MAX_FINAL_REPLY_ROWS}
          className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)] disabled:opacity-40"
          onClick={() => setRows([...rows, { op: "not_empty", valueText: "" }])}
        >
          <LuPlus className="size-3.5" aria-hidden /> Add final reply check
        </button>
      </div>
    </div>
  );
}

export function GoalReachedForm({ grader, onChange, judgeModels, judgeDefault }: FormProps & { judgeModels: readonly string[]; judgeDefault: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Judge model">
        <select className={SELECT} value={typeof grader.judge === "string" ? grader.judge : ""} onChange={(e) => onChange(setJudge(grader, e.target.value))}>
          <option value="">{judgeDefault ? `Eval default · ${judgeDefault}` : "Eval default"}</option>
          {judgeModels.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </Field>
      <JudgeSettingsFields grader={grader} onChange={onChange} />
      <Field label="Guidance (optional)" hint="Extra instructions for the judge.">
        <textarea
          className={`${TEXTAREA} min-h-[72px]`}
          value={typeof grader.guidance === "string" ? grader.guidance : ""}
          maxLength={GUIDANCE_MAX}
          onChange={(e) => {
            const { guidance: _g, ...rest } = grader;
            void _g;
            onChange((e.target.value === "" ? rest : { ...rest, guidance: e.target.value }) as GraderConfig);
          }}
        />
      </Field>
      <p className="text-xs text-[var(--sf-text-3)]">{GOAL_REACHED_NOTE}</p>
    </div>
  );
}
