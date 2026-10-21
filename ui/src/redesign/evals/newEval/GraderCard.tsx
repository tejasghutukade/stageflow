import { useState } from "react";
import { LuChevronDown, LuChevronRight, LuGripVertical, LuPlus, LuTrash2 } from "react-icons/lu";
import { INPUT, TEXTAREA } from "../datasets/DialogShell";
import { CARD, Chip, Field, MONO, SELECT } from "./parts";
import {
  CODE_HINT,
  FIELD_OPS,
  NOT_CALIBRATED,
  NOT_CALIBRATED_NOTE,
  addCheck,
  addExample,
  checkToRow,
  checksOf,
  chipFor,
  commonOf,
  describeGrader,
  examplesOf,
  opNeedsValue,
  parseWeight,
  removeCheck,
  removeExample,
  rowToCheck,
  scaleOf,
  setJudge,
  setPassAt,
  setScale,
  showPassAt,
  updateCheck,
  updateExample,
  validateGraderId,
  weightLabel,
  withCommon,
  MAX_EXAMPLES,
  type FieldCheckRow,
  type GraderConfig,
} from "./graderForms";

type Props = {
  grader: GraderConfig;
  otherIds: string[];
  judgeModels: string[];
  judgeDefault: string | null;
  outputSchemaName?: string;
  expanded: boolean;
  dragging: boolean;
  onToggle: () => void;
  onChange: (next: GraderConfig) => void;
  onRename: (id: string) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  dragHandlers: {
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
    onDragEnd: () => void;
  };
};

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-[var(--sf-text-2)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function CheckRows({ grader, onChange }: { grader: GraderConfig; onChange: (g: GraderConfig) => void }) {
  const [rows, setRows] = useState<FieldCheckRow[]>(() => checksOf(grader).map(checkToRow));
  const [errors, setErrors] = useState<Record<number, string>>({});

  function edit(i: number, patch: Partial<FieldCheckRow>) {
    const row = { ...(rows[i] as FieldCheckRow), ...patch };
    setRows(rows.map((r, j) => (j === i ? row : r)));
    const parsed = rowToCheck(row);
    setErrors((e) => {
      const { [i]: _drop, ...rest } = e;
      void _drop;
      return parsed.ok ? rest : { ...rest, [i]: parsed.error };
    });
    if (parsed.ok) onChange(updateCheck(grader, i, parsed.check));
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-[var(--sf-text-2)]">Checks (all must hold)</span>
      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="grid grid-cols-[minmax(0,1.6fr)_130px_minmax(0,1fr)_28px] items-center gap-2">
            <input className={`${INPUT} ${MONO}`} value={row.path} onChange={(e) => edit(i, { path: e.target.value })} aria-label="Path" placeholder="payload.findings[*].file" />
            <select className={SELECT} value={row.op} onChange={(e) => edit(i, { op: e.target.value })} aria-label="Operator">
              {FIELD_OPS.map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
            <input className={`${INPUT} ${MONO}`} value={row.valueText} disabled={!opNeedsValue(row.op)} onChange={(e) => edit(i, { valueText: e.target.value })} aria-label="Value" placeholder={opNeedsValue(row.op) ? "value" : ""} />
            <button
              type="button"
              aria-label="Remove check"
              disabled={rows.length <= 1}
              onClick={() => {
                setRows(rows.filter((_, j) => j !== i));
                setErrors({});
                onChange(removeCheck(grader, i));
              }}
              className="flex size-7 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] disabled:opacity-40"
            >
              <LuTrash2 className="size-3.5" aria-hidden />
            </button>
          </div>
          {errors[i] ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{errors[i]}</span> : null}
        </div>
      ))}
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-[13px] text-[var(--sf-text-1)]"
        onClick={() => {
          setRows([...rows, { path: "payload", op: "exists", valueText: "" }]);
          onChange(addCheck(grader));
        }}
      >
        <LuPlus className="size-3.5" aria-hidden /> Add check
      </button>
    </div>
  );
}

export function GraderCard(p: Props) {
  const g = p.grader;
  const common = commonOf(g);
  const [weightText, setWeightText] = useState(common.weight === null ? "" : String(common.weight));
  const [weightError, setWeightError] = useState<string | null>(null);
  const [idText, setIdText] = useState(g.id);
  const idError = validateGraderId(idText, p.otherIds);
  const weight = weightLabel(g);
  const isRubric = g.type === "rubric";
  const set = (patch: Record<string, unknown>) => {
    const next = { ...g, ...patch } as GraderConfig;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    p.onChange(next);
  };

  return (
    <div
      className={`${CARD} ${p.dragging ? "opacity-50" : ""}`}
      draggable
      onDragStart={p.dragHandlers.onDragStart}
      onDragOver={p.dragHandlers.onDragOver}
      onDrop={p.dragHandlers.onDrop}
      onDragEnd={p.dragHandlers.onDragEnd}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button
          type="button"
          aria-label={`Reorder ${g.id}`}
          title="Drag to reorder, or use the arrow keys"
          className="cursor-grab text-[var(--sf-text-3)]"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              p.onMove(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              p.onMove(1);
            }
          }}
        >
          <LuGripVertical className="size-4" aria-hidden />
        </button>
        <button type="button" onClick={p.onToggle} aria-expanded={p.expanded} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Chip tone={isRubric ? "info" : "neutral"}>{chipFor(g.type)}</Chip>
          <span className="flex min-w-0 flex-col">
            <span className={`${MONO} text-[13px] text-[var(--sf-text-1)]`}>{g.id}</span>
            <span className="truncate text-xs text-[var(--sf-text-3)]">{describeGrader(g, p.outputSchemaName)}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {isRubric ? <Chip tone="warn">{NOT_CALIBRATED}</Chip> : null}
            {g.must_pass === true ? <Chip tone="warn">must pass</Chip> : null}
            {weight ? <span className="text-xs text-[var(--sf-text-2)]">{weight}</span> : null}
            {p.expanded ? <LuChevronDown className="size-4 text-[var(--sf-text-3)]" aria-hidden /> : <LuChevronRight className="size-4 text-[var(--sf-text-3)]" aria-hidden />}
          </span>
        </button>
      </div>
      {p.expanded ? (
        <div className="flex flex-col gap-4 border-t border-t-[var(--sf-hairline)] px-3.5 py-4">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Field label="Id" error={idError ?? undefined}>
              <input
                className={`${INPUT} ${MONO}`}
                value={idText}
                onChange={(e) => setIdText(e.target.value)}
                onBlur={() => {
                  if (idText !== g.id && validateGraderId(idText, p.otherIds) === null) p.onRename(idText);
                }}
              />
            </Field>
            <Field label="Description (optional)">
              <input className={INPUT} value={common.description} maxLength={200} onChange={(e) => p.onChange(withCommon(g, { description: e.target.value }))} />
            </Field>
          </div>

          {g.type === "schema" ? <p className="text-[13px] text-[var(--sf-text-2)]">Output matches {p.outputSchemaName ?? "the stage's output schema"}.</p> : null}

          {g.type === "field" ? <CheckRows grader={g} onChange={p.onChange} /> : null}

          {g.type === "reference" ? (
            <div className="grid grid-cols-4 gap-3">
              <Field label="Mode">
                <select className={SELECT} value={String(g.mode ?? "each_mentioned")} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="each_mentioned">each_mentioned</option>
                  <option value="equals">equals</option>
                </select>
              </Field>
              <Field label="Path">
                <input className={`${INPUT} ${MONO}`} value={String(g.path ?? "")} onChange={(e) => set({ path: e.target.value === "" ? undefined : e.target.value })} placeholder="payload" />
              </Field>
              <Field label="Expected path">
                <input className={`${INPUT} ${MONO}`} value={String(g.expected ?? "")} onChange={(e) => set({ expected: e.target.value })} placeholder="expected.findings" />
              </Field>
              <Field label="Pass at (0 to 1)">
                <input
                  className={INPUT}
                  inputMode="decimal"
                  value={g.pass_at === undefined ? "" : String(g.pass_at)}
                  placeholder="1"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    set({ pass_at: e.target.value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1 ? undefined : n });
                  }}
                />
              </Field>
            </div>
          ) : null}

          {isRubric ? (
            <>
              <Field label="What the judge looks for">
                <textarea className={`${TEXTAREA} min-h-[88px]`} value={String(g.rubric ?? "")} maxLength={4000} onChange={(e) => set({ rubric: e.target.value })} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
                  <span>Scale</span>
                  <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5" role="radiogroup" aria-label="Scale">
                    {(
                      [
                        ["pass_fail", "Pass / fail"],
                        ["1_to_5", "1 to 5"],
                      ] as const
                    ).map(([value, label]) => (
                      <button key={value} type="button" role="radio" aria-checked={scaleOf(g) === value} onClick={() => p.onChange(setScale(g, value))} className={`h-7 flex-1 rounded-md text-[13px] ${scaleOf(g) === value ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {showPassAt(g) ? (
                  <Field label="Passes at">
                    <select className={SELECT} value={String(g.pass_at ?? 4)} onChange={(e) => p.onChange(setPassAt(g, Number(e.target.value)))}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>{n} or higher</option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <Field label="Judge model">
                  <select className={SELECT} value={typeof g.judge === "string" ? g.judge : ""} onChange={(e) => p.onChange(setJudge(g, e.target.value))}>
                    <option value="">{p.judgeDefault ? `Eval default · ${p.judgeDefault}` : "Eval default"}</option>
                    {p.judgeModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[13px] text-[var(--sf-text-2)]">
                  <span>Examples the judge sees <span className="text-[var(--sf-text-3)]">{examplesOf(g).length}</span></span>
                  <button type="button" disabled={examplesOf(g).length >= MAX_EXAMPLES} className="text-[var(--sf-text-1)] disabled:opacity-40" onClick={() => p.onChange(addExample(g))}>
                    Add example
                  </button>
                </div>
                {examplesOf(g).map((ex, i) => (
                  <div key={i} className="grid grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)_28px] items-start gap-2 rounded-lg border border-[var(--sf-hairline)] p-2">
                    {ex.verdict !== undefined ? (
                      <select className={SELECT} value={ex.verdict} onChange={(e) => p.onChange(updateExample(g, i, { verdict: e.target.value as "pass" | "fail" }))} aria-label="Verdict">
                        <option value="pass">PASS</option>
                        <option value="fail">FAIL</option>
                      </select>
                    ) : (
                      <select className={SELECT} value={ex.score ?? 3} onChange={(e) => p.onChange(updateExample(g, i, { score: Number(e.target.value) }))} aria-label="Score">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>{n} / 5</option>
                        ))}
                      </select>
                    )}
                    <textarea className={`${TEXTAREA} min-h-[56px]`} value={ex.output} placeholder="Output text" onChange={(e) => p.onChange(updateExample(g, i, { output: e.target.value }))} aria-label="Example output" />
                    <textarea className={`${TEXTAREA} min-h-[56px]`} value={ex.reason ?? ""} placeholder="Reason (optional)" onChange={(e) => p.onChange(updateExample(g, i, { reason: e.target.value }))} aria-label="Example reason" />
                    <button type="button" aria-label="Remove example" className="flex size-7 items-center justify-center rounded text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)]" onClick={() => p.onChange(removeExample(g, i))}>
                      <LuTrash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[var(--sf-text-3)]">{NOT_CALIBRATED_NOTE}</p>
            </>
          ) : null}

          {g.type === "code" ? (
            <Field label="Function body" hint={CODE_HINT}>
              <textarea className={`${TEXTAREA} ${MONO} min-h-[120px]`} value={String(g.code ?? "")} spellCheck={false} onChange={(e) => set({ code: e.target.value })} />
            </Field>
          ) : null}

          <div className="flex items-end gap-4">
            <div className="w-32">
              <Field label="Weight" error={weightError ?? undefined} hint={common.mustPass ? "Ignored for must-pass graders" : "Default 1"}>
                <input
                  className={INPUT}
                  inputMode="decimal"
                  value={weightText}
                  placeholder="1"
                  onChange={(e) => {
                    setWeightText(e.target.value);
                    const parsed = parseWeight(e.target.value);
                    if (parsed.ok) {
                      setWeightError(null);
                      p.onChange(withCommon(g, { weight: parsed.value }));
                    } else setWeightError(parsed.error);
                  }}
                />
              </Field>
            </div>
            <Toggle label="Must pass" checked={common.mustPass} onChange={(v) => p.onChange(withCommon(g, { mustPass: v }))} />
            <button type="button" onClick={p.onRemove} className="ml-auto flex items-center gap-1.5 text-[13px] text-[var(--sf-fail)]">
              <LuTrash2 className="size-3.5" aria-hidden /> Remove grader
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
