import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LuMaximize2 } from "react-icons/lu";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import {
  ChangeTag,
  FieldErrors,
  FieldLabel,
  MONO,
  ROW_KEY,
  IoFieldEditor,
  SelectControl,
  Switch,
  controlClass,
  hasError,
  useLocalText,
} from "./inspectorFields";
import { PromptExpandDialog } from "./PromptExpandDialog";
import {
  GATE_KINDS,
  errorChipValues,
  findingsForField,
  getPipelineForm,
  getStageForm,
  normalizeStageFieldKey,
  pipelineFileLabel,
  promptStats,
  resolvedStageModel,
  setStageGateKind,
  setStageHitl,
  renameStageIoField,
  setStageIoFieldRequired,
  setStageIoFieldType,
  setStageIoFields,
  setStageMaxAttempts,
  setStageModel,
  setStageOnVerifyFail,
  setStageRetrySafety,
  setStageSystemPrompt,
  setStageVerifyCommand,
  stageChangeKind,
  stageHasAfterVerify,
  type GateKind,
  type IoFieldType,
  type OnVerifyFailMode,
  type RetrySafety,
  type StageFieldKey,
  type StageForm,
} from "./stageFields";

export type StageFocusRequest = { field: string; nonce: number };

export type WorkshopStageInspectorProps = {
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  stageId: string;
  findings: ValidationFinding[];
  models: string[];
  defaultModel: string | null;
  onDraftChange: (draft: DraftPackagePayload) => void;
  onRenameStage: (fromId: string, toId: string) => void;
  focusRequest?: StageFocusRequest | null;
  onFocusHandled?: () => void;
  usedByCount?: number | null;
};

const FLASH_MS = 1400;

const VERIFY_FAIL_SEGMENTS: Array<{ mode: OnVerifyFailMode; label: string; grow: string }> = [
  { mode: "fail", label: "fail", grow: "flex-1" },
  { mode: "retry", label: "retry", grow: "flex-1" },
  { mode: "ask_operator", label: "ask_operator", grow: "flex-[1.6_1_0%]" },
];

const MULTI_GATE = "__multi__";

function Field({
  fieldKey,
  register,
  className = "flex flex-col gap-[5px]",
  children,
}: {
  fieldKey: StageFieldKey;
  register: (key: StageFieldKey, el: HTMLDivElement | null) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div ref={(el) => register(fieldKey, el)} data-field={fieldKey} className={className}>
      {children}
    </div>
  );
}

function IdField({
  form,
  otherIds,
  findings,
  flash,
  onRename,
}: {
  form: StageForm;
  otherIds: string[];
  findings: ValidationFinding[];
  flash: boolean;
  onRename: (toId: string) => void;
}) {
  const { text, setText, setEditing } = useLocalText(form.id);
  const trimmed = text.trim();
  const conflict = trimmed !== form.id && otherIds.includes(trimmed);
  const empty = trimmed === "";

  function commit() {
    setEditing(false);
    if (empty || conflict || trimmed === form.id) {
      setText(form.id);
      return;
    }
    onRename(trimmed);
  }

  const localErrors: ValidationFinding[] = conflict
    ? [{ severity: "error", code: "local.duplicate_id", path: "", message: `Another stage already uses "${trimmed}"`, category: "stage" }]
    : empty
      ? [{ severity: "error", code: "local.empty_id", path: "", message: "Stage id is required", category: "stage" }]
      : [];

  return (
    <>
      <div className={controlClass({ error: conflict || empty || hasError(findings), flash, className: "h-[30px] px-2.5" })}>
        <input
          aria-label="Stage id"
          value={text}
          spellCheck={false}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setText(form.id);
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
          className={`h-full min-w-0 flex-1 bg-transparent text-xs leading-normal text-[#ecedee] outline-none ${MONO}`}
        />
      </div>
      <FieldErrors findings={[...localErrors, ...findings]} />
    </>
  );
}

function VerifyCommandField({
  value,
  findings,
  flash,
  onCommit,
}: {
  value: string;
  findings: ValidationFinding[];
  flash: boolean;
  onCommit: (value: string) => void;
}) {
  const { text, setText, setEditing } = useLocalText(value);

  function commit() {
    setEditing(false);
    if (text.trim() !== value.trim()) onCommit(text);
  }

  return (
    <>
      <div className={controlClass({ error: hasError(findings), flash, className: "h-[30px] gap-1.5 px-2.5" })}>
        <span className={`shrink-0 text-xs leading-normal text-[#8b8f98] ${MONO}`}>$</span>
        <input
          aria-label="verify command"
          value={text}
          spellCheck={false}
          placeholder="no command check"
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setText(value);
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
          className={`h-full min-w-0 flex-1 bg-transparent text-xs leading-normal text-[#ecedee] outline-none placeholder:text-[#8b8f98] ${MONO}`}
        />
      </div>
      <FieldErrors findings={findings} />
    </>
  );
}

function MaxAttemptsRow({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const { text, setText, setEditing } = useLocalText(String(value));

  function commit() {
    setEditing(false);
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n) && n >= 1 && n !== value) onCommit(n);
    else setText(String(value));
  }

  return (
    <div className="flex items-center gap-2">
      <div className={ROW_KEY}>Max attempts</div>
      <div className={controlClass({ className: "h-[30px] w-[72px] px-2.5" })}>
        <input
          aria-label="Max attempts"
          inputMode="numeric"
          value={text}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className={`h-full min-w-0 flex-1 bg-transparent text-xs leading-normal text-[#ecedee] outline-none ${MONO}`}
        />
      </div>
    </div>
  );
}

export function WorkshopStageInspector({
  draft,
  baseline,
  stageId,
  findings,
  models,
  defaultModel,
  onDraftChange,
  onRenameStage,
  focusRequest,
  onFocusHandled,
  usedByCount = null,
}: WorkshopStageInspectorProps) {
  const form = getStageForm(draft, stageId);
  const fieldEls = useRef(new Map<StageFieldKey, HTMLDivElement>());
  const [flashKey, setFlashKey] = useState<StageFieldKey | null>(null);
  const lastNonce = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const prompt = useLocalText(form?.systemPrompt ?? "");

  const byField = useMemo(
    () => findingsForField(findings, stageId, form?.path ?? null),
    [findings, stageId, form?.path],
  );

  function register(key: StageFieldKey, el: HTMLDivElement | null) {
    if (el) fieldEls.current.set(key, el);
    else fieldEls.current.delete(key);
  }

  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === lastNonce.current) return;
    lastNonce.current = focusRequest.nonce;
    const key = normalizeStageFieldKey(focusRequest.field);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const target = fieldEls.current.get(key) ?? fieldEls.current.get("id");
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        const focusable = target.querySelector<HTMLElement>(
          "input, textarea, select, button:not([disabled])",
        );
        focusable?.focus({ preventScroll: true });
      }
      setFlashKey(key === "general" ? "id" : key);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFlashKey(null), FLASH_MS);
      onFocusHandled?.();
    });
  }, [focusRequest?.nonce]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (!form) return null;

  const changeKind = stageChangeKind(draft, baseline, stageId);
  const otherIds = getPipelineForm(draft)
    .stages.map((s) => s.id)
    .filter((id) => id !== stageId);
  const resolvedModel = resolvedStageModel(draft, form, defaultModel);
  const modelOptions = [
    { value: "", label: resolvedModel ? `Inherits default (${resolvedModel})` : "Inherits default" },
    ...Array.from(new Set([...(form.model ? [form.model] : []), ...models])).map((m) => ({ value: m, label: m })),
  ];
  const stats = promptStats(prompt.text);
  const pathLabel = form.path ?? `inline in ${pipelineFileLabel(draft.pipeline.id)}`;
  const verifyMode = form.onVerifyFail ?? "fail";
  const needsAfterVerify = verifyMode !== "fail" && !stageHasAfterVerify(draft, stageId);
  const gateValue = form.gateKinds.length > 1 ? MULTI_GATE : (form.gateKind ?? "confirm");
  const gateOptions = [
    ...(form.gateKinds.length > 1 ? [{ value: MULTI_GATE, label: form.gateKinds.join(", ") }] : []),
    ...GATE_KINDS.map((kind) => ({ value: kind, label: kind })),
  ];

  function updatePrompt(next: string) {
    prompt.setText(next);
    onDraftChange(setStageSystemPrompt(draft, stageId, next));
  }

  function applyIo(
    side: "input" | "output",
    field: { name: string; type: IoFieldType; required: boolean },
  ) {
    let next = setStageIoFields(draft, stageId, side, [
      ...(side === "input" ? form!.inputs : form!.outputs),
      field.name,
    ]);
    if (field.type !== "string") next = setStageIoFieldType(next, stageId, side, field.name, field.type);
    if (!field.required) next = setStageIoFieldRequired(next, stageId, side, field.name, false);
    onDraftChange(next);
  }

  function ioRow(side: "input" | "output") {
    const key: StageFieldKey = side === "input" ? "io.inputs" : "io.outputs";
    const values = side === "input" ? form!.inputs : form!.outputs;
    const ioFields = side === "input" ? form!.inputFields : form!.outputFields;
    const ref = side === "input" ? form!.inputsRef : form!.outputsRef;
    const fieldFindings = byField[key];
    return (
      <Field fieldKey={key} register={register} className="flex flex-col gap-[5px]">
        <div className={`flex items-start gap-2 ${side === "output" ? "pt-0.5" : ""}`}>
          <div className={`w-[50px] shrink-0 pt-1.5 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}>
            {side === "input" ? "inputs" : "outputs"}
          </div>
          <IoFieldEditor
            side={side}
            fields={ioFields}
            schemaName={ref}
            error={hasError(fieldFindings)}
            errorValues={errorChipValues(values, fieldFindings)}
            flash={flashKey === key}
            onAdd={(field) => applyIo(side, field)}
            onRename={(from, to) => onDraftChange(renameStageIoField(draft, stageId, side, from, to))}
            onType={(name, type) => onDraftChange(setStageIoFieldType(draft, stageId, side, name, type))}
            onRequired={(name, required) =>
              onDraftChange(setStageIoFieldRequired(draft, stageId, side, name, required))
            }
            onRemove={(removed) =>
              onDraftChange(setStageIoFields(draft, stageId, side, values.filter((v) => v !== removed)))
            }
          />
        </div>
        <FieldErrors findings={fieldFindings} indent />
      </Field>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <div className="flex w-full shrink-0 flex-col gap-[3px] border-b border-b-[#ffffff12] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`min-w-0 truncate text-sm font-medium leading-normal text-[#ecedee] ${MONO}`}>
            {form.id}
          </div>
          <ChangeTag kind={changeKind} />
        </div>
        <div className={`truncate text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>
          {pathLabel}
          {changeKind !== "unchanged" ? " · unsaved" : ""}
          {usedByCount != null && usedByCount > 1 ? ` · Used by ${usedByCount}` : ""}
        </div>
        {usedByCount != null && usedByCount > 1 ? (
          <div className="text-[11px] leading-[1.45] text-[#a7aab2]">
            Shared stage. Saving writes this file for every pipeline that uses it.
          </div>
        ) : null}
      </div>

      <div className="flex w-full flex-col gap-3 px-3.5 py-3">
        {byField.general.length > 0 ? <FieldErrors findings={byField.general} /> : null}

        <Field fieldKey="id" register={register}>
          <FieldLabel>id</FieldLabel>
          <IdField
            form={form}
            otherIds={otherIds}
            findings={byField.id}
            flash={flashKey === "id"}
            onRename={(toId) => onRenameStage(stageId, toId)}
          />
        </Field>

        <Field fieldKey="model" register={register}>
          <FieldLabel>model</FieldLabel>
          <SelectControl
            ariaLabel="Stage model"
            value={form.model ?? ""}
            options={modelOptions}
            error={hasError(byField.model)}
            flash={flashKey === "model"}
            onChange={(value) => onDraftChange(setStageModel(draft, stageId, value || null))}
          >
            {form.model ? (
              <span className={`min-w-0 flex-1 truncate text-xs leading-normal text-[#ecedee] ${MONO}`}>
                {form.model}
              </span>
            ) : (
              <>
                <span className="whitespace-nowrap text-xs leading-normal text-[#ecedee]">Inherits default</span>
                <span
                  className={`min-w-0 flex-1 truncate text-right text-[11px] leading-normal text-[#8b8f98] ${MONO}`}
                >
                  {resolvedModel ?? "none set"}
                </span>
              </>
            )}
          </SelectControl>
          <FieldErrors findings={byField.model} />
        </Field>

        <Field fieldKey="system_prompt" register={register}>
          <div className="flex items-center justify-between">
            <FieldLabel>system_prompt</FieldLabel>
            <button
              type="button"
              aria-label="Expand system_prompt"
              onClick={() => setExpanded(true)}
              className="-m-1 flex size-5 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
            >
              <LuMaximize2 className="size-3" aria-hidden />
            </button>
          </div>
          <div
            className={controlClass({
              error: hasError(byField.system_prompt),
              flash: flashKey === "system_prompt",
              className: "flex-col items-stretch gap-1 px-2.5 py-[7px]",
            })}
          >
            <textarea
              aria-label="system_prompt"
              value={prompt.text}
              rows={5}
              spellCheck={false}
              placeholder="What should this stage do?"
              onFocus={() => prompt.setEditing(true)}
              onBlur={() => prompt.setEditing(false)}
              onChange={(event) => updatePrompt(event.target.value)}
              className="min-h-[72px] w-full resize-y bg-transparent text-xs leading-normal text-[#a7aab2] outline-none placeholder:text-[#8b8f98] focus:text-[#ecedee]"
            />
            <div className={`text-[11px] leading-normal text-[#8b8f98] ${MONO}`}>
              {stats.lines} lines · {stats.chars} chars
            </div>
          </div>
          <FieldErrors findings={byField.system_prompt} />
        </Field>

        <div className="flex flex-col gap-[5px]">
          <FieldLabel>io</FieldLabel>
          {ioRow("input")}
          {ioRow("output")}
        </div>

        <Field fieldKey="verify.command" register={register}>
          <FieldLabel>verify · command</FieldLabel>
          <VerifyCommandField
            value={form.verifyCommand}
            findings={byField["verify.command"]}
            flash={flashKey === "verify.command"}
            onCommit={(value) => onDraftChange(setStageVerifyCommand(draft, stageId, value))}
          />
        </Field>

        <Field fieldKey="on_verify_fail" register={register}>
          <FieldLabel>on_verify_fail</FieldLabel>
          <div
            role="radiogroup"
            aria-label="on_verify_fail"
            className={controlClass({
              error: hasError(byField.on_verify_fail),
              flash: flashKey === "on_verify_fail",
              className: "h-[30px] items-stretch gap-0.5 p-0.5",
            })}
          >
            {VERIFY_FAIL_SEGMENTS.map((segment) => {
              const selected = segment.mode === verifyMode;
              return (
                <button
                  key={segment.mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    if (!selected) onDraftChange(setStageOnVerifyFail(draft, stageId, segment.mode));
                  }}
                  className={
                    selected
                      ? `flex ${segment.grow} items-center justify-center rounded-md border border-[#ffffff1a] bg-[#2a2d33] text-[11px] font-medium leading-normal text-[#ecedee] ${MONO}`
                      : `flex ${segment.grow} items-center justify-center rounded-md text-[11px] leading-normal text-[#a7aab2] hover:text-[#ecedee] ${MONO}`
                  }
                >
                  {segment.label}
                </button>
              );
            })}
          </div>
          {verifyMode === "retry" ? (
            <MaxAttemptsRow
              value={form.maxAttempts ?? 2}
              onCommit={(n) => onDraftChange(setStageMaxAttempts(draft, stageId, n))}
            />
          ) : null}
          {verifyMode === "ask_operator" ? (
            <div className="flex items-center gap-2">
              <div className={ROW_KEY}>Retry safety</div>
              <SelectControl
                ariaLabel="Retry safety"
                className="flex-1"
                value={form.retrySafety ?? "side_effecting"}
                options={[
                  { value: "side_effecting", label: "side_effecting" },
                  { value: "idempotent", label: "idempotent" },
                ]}
                onChange={(value) => onDraftChange(setStageRetrySafety(draft, stageId, value as RetrySafety))}
              >
                <span className={`min-w-0 flex-1 truncate text-xs leading-normal text-[#ecedee] ${MONO}`}>
                  {form.retrySafety ?? "side_effecting"}
                </span>
              </SelectControl>
            </div>
          ) : null}
          {needsAfterVerify ? (
            <div className="text-[11px] leading-[1.45] text-[#8b8f98]">
              Applies only after an after-phase verify check fails.
            </div>
          ) : null}
          <FieldErrors findings={byField.on_verify_fail} />
        </Field>

        <Field fieldKey="ask_operator" register={register} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <FieldLabel className="flex-1">ask_operator · HITL</FieldLabel>
            <Switch
              on={form.hitl}
              ariaLabel="ask_operator HITL"
              onChange={(on) => onDraftChange(setStageHitl(draft, stageId, on))}
            />
          </div>
          {form.hitl ? (
            <div className="flex items-center gap-2">
              <div className={ROW_KEY}>Gate kind</div>
              <SelectControl
                ariaLabel="Gate kind"
                className="flex-1"
                value={gateValue}
                options={gateOptions}
                error={hasError(byField.ask_operator)}
                flash={flashKey === "ask_operator"}
                onChange={(value) => {
                  if (value !== MULTI_GATE) onDraftChange(setStageGateKind(draft, stageId, value as GateKind));
                }}
              >
                <span className={`min-w-0 flex-1 truncate text-xs leading-normal text-[#ecedee] ${MONO}`}>
                  {form.gateKinds.length > 1 ? form.gateKinds.join(", ") : (form.gateKind ?? "confirm")}
                </span>
              </SelectControl>
            </div>
          ) : null}
          <FieldErrors findings={byField.ask_operator} />
        </Field>

        <div className="flex flex-col gap-1">
          <FieldLabel className="pb-0.5">envelope · artifacts</FieldLabel>
          {(
            [
              ["artifacts", form.envelope.artifacts.join(", ")],
              ["payload", form.envelope.payload.join(" · ")],
              ["status", form.envelope.status],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="flex h-[22px] items-center gap-2">
              <div className={`w-[66px] shrink-0 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}>{key}</div>
              <div
                className={`min-w-0 truncate text-[11px] leading-normal ${MONO} ${
                  key === "status" || !value ? "text-[#8b8f98]" : "text-[#ecedee]"
                }`}
                title={value || undefined}
              >
                {value || "—"}
              </div>
            </div>
          ))}
        </div>
      </div>

      {expanded ? (
        <PromptExpandDialog
          stageId={stageId}
          value={prompt.text}
          onChange={updatePrompt}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  );
}
