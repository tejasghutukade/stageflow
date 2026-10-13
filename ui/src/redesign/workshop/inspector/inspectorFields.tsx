import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { LuChevronDown, LuPlus, LuTriangleAlert, LuX } from "react-icons/lu";
import type { ValidationFinding } from "../../../api";
import {
  IO_FIELD_TYPES,
  ioFieldChipLabel,
  type IoField,
  type IoFieldType,
  type StageChangeKind,
} from "./stageFields";

export const MONO = "font-['Geist_Mono',monospace]";

export const FIELD_LABEL =
  "w-fit text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";

export const ROW_KEY = "w-[66px] shrink-0 text-xs leading-normal text-[#a7aab2]";

const CONTROL_BASE =
  "flex min-w-0 items-center rounded-lg border bg-[#1a1c21] transition-[border-color,box-shadow] duration-300 focus-within:border-[#ffffff33] focus-within:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]";

export function controlClass({
  error = false,
  flash = false,
  className = "",
}: {
  error?: boolean;
  flash?: boolean;
  className?: string;
}): string {
  const tone = flash
    ? "border-[#6ca6ff] shadow-[0px_0px_0px_3px_rgba(108,166,255,0.18)]"
    : error
      ? "border-[#f2645aa6]"
      : "border-[#ffffff1a]";
  return `${CONTROL_BASE} ${tone} ${className}`.trim();
}

export function FieldLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${FIELD_LABEL} ${className}`.trim()}>{children}</div>;
}

export function FieldErrors({
  findings,
  indent = false,
}: {
  findings: ValidationFinding[];
  indent?: boolean;
}) {
  if (findings.length === 0) return null;
  return (
    <div className={`flex flex-col gap-1 ${indent ? "pl-[58px]" : ""}`}>
      {findings.map((finding, i) => {
        const isError = finding.severity === "error";
        const Icon = isError ? LuX : LuTriangleAlert;
        return (
          <div key={`${finding.code}-${i}`} className="flex items-start gap-[5px]">
            <Icon
              className={`mt-0.5 size-3 shrink-0 ${isError ? "text-[#f2645a]" : "text-[#a7aab2]"}`}
              aria-hidden
            />
            <div
              className={`min-w-0 text-[11px] leading-[1.45] [overflow-wrap:anywhere] ${isError ? "text-[#f2645a]" : "text-[#a7aab2]"}`}
            >
              {finding.message}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function hasError(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function ChangeTag({ kind }: { kind: StageChangeKind }) {
  if (kind === "unchanged") return null;
  const tone =
    kind === "new"
      ? "bg-[#6ca6ff24] border-solid"
      : "border-dashed";
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded-sm border border-[#6ca6ff99] px-[5px] text-[10px] font-medium leading-normal text-[#6ca6ff] ${tone}`}
    >
      {kind}
    </span>
  );
}

export function useLocalText(value: string): {
  text: string;
  setText: (next: string) => void;
  editing: boolean;
  setEditing: (editing: boolean) => void;
} {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  return { text, setText, editing, setEditing };
}

export function SelectControl({
  value,
  options,
  onChange,
  children,
  ariaLabel,
  error = false,
  flash = false,
  selectRef,
  className = "",
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel: string;
  error?: boolean;
  flash?: boolean;
  selectRef?: Ref<HTMLSelectElement>;
  className?: string;
}) {
  return (
    <div className={controlClass({ error, flash, className: `relative h-[30px] gap-1.5 px-2.5 ${className}` })}>
      {children}
      <LuChevronDown className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
      <select
        ref={selectRef}
        aria-label={ariaLabel}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-lg opacity-0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Switch({
  on,
  onChange,
  ariaLabel,
  buttonRef,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  ariaLabel: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className={
        on
          ? "flex h-4 w-[26px] shrink-0 items-center justify-end rounded-full bg-[#ecedee] px-0.5"
          : "flex h-4 w-[26px] shrink-0 items-center justify-start rounded-full border border-[#ffffff1a] bg-[#2a2d33] px-0.5"
      }
    >
      <span
        className={on ? "block size-3 rounded-full bg-[#0c0d0f]" : "block size-2.5 rounded-full bg-[#8b8f98]"}
      />
    </button>
  );
}

export function ChipEditor({
  values,
  onAdd,
  onRemove,
  error = false,
  errorValues = [],
  lockedLabel = null,
  addLabel,
  flash = false,
  focusRef,
  suggestions,
}: {
  values: string[];
  onAdd: (values: string[]) => void;
  onRemove: (value: string) => void;
  error?: boolean;
  errorValues?: string[];
  lockedLabel?: string | null;
  addLabel: string;
  flash?: boolean;
  focusRef?: Ref<HTMLButtonElement>;
  suggestions?: string[];
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function commit(keepOpen: boolean) {
    const parts: string[] = [];
    for (const raw of text.split(/[\s,]+/)) {
      const part = raw.trim();
      if (part && !values.includes(part) && !parts.includes(part)) parts.push(part);
    }
    if (parts.length > 0) onAdd(parts);
    setText("");
    if (!keepOpen) setAdding(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setText("");
      setAdding(false);
    } else if (event.key === "Backspace" && text === "" && values.length > 0) {
      onRemove(values[values.length - 1]!);
    }
  }

  return (
    <div
      className={controlClass({
        error,
        flash,
        className: "min-h-[30px] flex-1 flex-wrap gap-1.5 px-1.5 py-[4px]",
      })}
    >
      {lockedLabel ? (
        <span
          className={`inline-flex h-5 min-w-0 items-center truncate rounded-sm border border-dashed border-[#ffffff26] px-1.5 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}
          title="Defined by a shared pipeline schema"
        >
          {lockedLabel}
        </span>
      ) : null}
      {values.map((value) => {
        const bad = errorValues.includes(value);
        return (
          <span
            key={value}
            className={
              bad
                ? `group inline-flex h-5 min-w-0 items-center gap-1 rounded-sm bg-[#f2645a1a] px-1.5 text-[11px] leading-normal text-[#f2645a] ${MONO}`
                : `group inline-flex h-5 min-w-0 items-center gap-1 rounded-sm border border-[#ffffff1a] bg-[#131418] px-1.5 text-[11px] leading-normal text-[#ecedee] ${MONO}`
            }
          >
            <span className="truncate">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onRemove(value)}
              className="-mr-0.5 hidden size-3 items-center justify-center rounded-sm text-[#8b8f98] hover:text-[#ecedee] group-hover:flex"
            >
              <LuX className="size-2.5" aria-hidden />
            </button>
          </span>
        );
      })}
      {adding ? (
        <>
          <input
            ref={inputRef}
            value={text}
            aria-label={addLabel}
            list={suggestions ? listId : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commit(false)}
            placeholder="name"
            className={`h-5 w-[96px] min-w-0 bg-transparent text-[11px] leading-normal text-[#ecedee] outline-none placeholder:text-[#8b8f98] ${MONO}`}
          />
          {suggestions ? (
            <datalist id={listId}>
              {suggestions
                .filter((s) => !values.includes(s))
                .map((s) => (
                  <option key={s} value={s} />
                ))}
            </datalist>
          ) : null}
        </>
      ) : null}
      <span className="block flex-1" />
      {lockedLabel ? null : (
        <button
          ref={focusRef}
          type="button"
          aria-label={addLabel}
          onClick={() => setAdding(true)}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
        >
          <LuPlus className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

const IO_TYPE_OPTIONS: Array<{ value: IoFieldType; label: string }> = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "string[]", label: "list of strings" },
  { value: "object", label: "object" },
];

function ioHint(side: "input" | "output", schemaName: string | null): string {
  if (schemaName) return `Uses the shared schema ${schemaName}.`;
  return side === "input"
    ? "Fields this stage needs before it starts. They must already be on the previous stage’s output."
    : "Fields this stage must include when it finishes.";
}

function IoTypeSelect({
  value,
  extra,
  onChange,
  ariaLabel,
}: {
  value: string;
  extra?: { value: string; label: string };
  onChange: (value: IoFieldType) => void;
  ariaLabel: string;
}) {
  const options = extra ? [extra, ...IO_TYPE_OPTIONS] : IO_TYPE_OPTIONS;
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <SelectControl
      value={current.value}
      options={options}
      ariaLabel={ariaLabel}
      onChange={(next) => {
        if ((IO_FIELD_TYPES as readonly string[]).includes(next)) onChange(next as IoFieldType);
      }}
      className="h-[30px] w-full"
    >
      <span className={`min-w-0 flex-1 truncate text-xs text-[#ecedee] ${MONO}`}>{current.label}</span>
    </SelectControl>
  );
}

function RequiredSwitch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] leading-normal text-[#a7aab2]">required</span>
      <Switch on={on} onChange={onChange} ariaLabel="Required" />
    </div>
  );
}

export function IoFieldEditor({
  side,
  fields,
  schemaName,
  error = false,
  errorValues = [],
  flash = false,
  onAdd,
  onRename,
  onType,
  onRequired,
  onRemove,
}: {
  side: "input" | "output";
  fields: IoField[];
  schemaName: string | null;
  error?: boolean;
  errorValues?: string[];
  flash?: boolean;
  onAdd: (field: { name: string; type: IoFieldType; required: boolean }) => void;
  onRename: (from: string, to: string) => void;
  onType: (name: string, type: IoFieldType) => void;
  onRequired: (name: string, required: boolean) => void;
  onRemove: (name: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; type: IoFieldType; required: boolean } | null>(null);
  const draftNameRef = useRef<HTMLInputElement>(null);
  const names = fields.map((field) => field.name).join("\0");

  useEffect(() => {
    if (open && open !== "__none__" && !fields.some((field) => field.name === open)) setOpen(null);
  }, [names, open, fields]);

  const draftOpen = draft !== null;
  useEffect(() => {
    if (draftOpen) draftNameRef.current?.focus();
  }, [draftOpen]);

  function commitDraft(next: { name: string; type: IoFieldType; required: boolean } | null) {
    if (!next) return;
    const name = next.name.trim();
    if (!name || fields.some((field) => field.name === name)) {
      if (!name) setDraft(null);
      return;
    }
    onAdd(next.name.trim() === name ? { ...next, name } : next);
    setDraft(null);
    setOpen(name);
  }

  const openField = fields.find((field) => field.name === open) ?? null;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div
        className={controlClass({
          error,
          flash,
          className: "min-h-[30px] flex-wrap gap-1.5 px-1.5 py-[4px]",
        })}
      >
        {schemaName ? (
          <span
            className={`inline-flex h-5 min-w-0 items-center truncate rounded-sm border border-dashed border-[#ffffff26] px-1.5 text-[11px] leading-normal text-[#a7aab2] ${MONO}`}
            title="Defined by a shared pipeline schema"
          >
            {schemaName}
          </span>
        ) : null}
        {fields.map((field) => {
          const bad = errorValues.includes(field.name);
          const selected = open === field.name;
          return (
            <span
              key={field.name}
              className={
                bad
                  ? `group inline-flex h-5 min-w-0 items-center gap-1 rounded-sm bg-[#f2645a1a] px-1.5 text-[11px] leading-normal text-[#f2645a] ${MONO}`
                  : selected
                    ? `group inline-flex h-5 min-w-0 items-center gap-1 rounded-sm border border-[#6ca6ff73] bg-[#6ca6ff1a] px-1.5 text-[11px] leading-normal text-[#6ca6ff] ${MONO}`
                    : `group inline-flex h-5 min-w-0 items-center gap-1 rounded-sm border border-[#ffffff1a] bg-[#131418] px-1.5 text-[11px] leading-normal text-[#ecedee] ${MONO}`
              }
            >
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Edit ${field.name}`}
                onClick={() => {
                  setDraft(null);
                  setOpen(selected ? null : field.name);
                }}
                className="min-w-0 truncate"
              >
                {ioFieldChipLabel(field)}
              </button>
              <button
                type="button"
                aria-label={`Remove ${field.name}`}
                onClick={() => {
                  if (open === field.name) setOpen(null);
                  onRemove(field.name);
                }}
                className="-mr-0.5 hidden size-3 shrink-0 items-center justify-center rounded-sm text-current hover:opacity-100 group-hover:flex"
              >
                <LuX className="size-2.5" aria-hidden />
              </button>
            </span>
          );
        })}
        <span className="block flex-1" />
        {schemaName ? null : (
          <button
            type="button"
            aria-label={`Add ${side === "input" ? "input" : "output"} field`}
            onClick={() => {
              setOpen(null);
              setDraft({ name: "", type: "string", required: true });
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
          >
            <LuPlus className="size-3" aria-hidden />
          </button>
        )}
      </div>
      {draft ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] p-2"
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            commitDraft(draft);
          }}
        >
          <input
            ref={draftNameRef}
            value={draft.name}
            aria-label="Field name"
            placeholder="story_id"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft(draft);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
            className={`h-[30px] rounded-lg border border-[#ffffff1a] bg-[#131418] px-2.5 text-xs text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ffffff33] ${MONO}`}
          />
          <IoTypeSelect
            value={draft.type}
            ariaLabel="Field type"
            onChange={(type) => setDraft({ ...draft, type })}
          />
          <RequiredSwitch on={draft.required} onChange={(required) => setDraft({ ...draft, required })} />
        </div>
      ) : null}
      {openField ? (
        <OpenIoField
          field={openField}
          onRename={(to) => {
            setOpen(to);
            onRename(openField.name, to);
          }}
          onType={(type) => onType(openField.name, type)}
          onRequired={(required) => onRequired(openField.name, required)}
        />
      ) : null}
      <p className="text-[11px] leading-[1.4] text-[#8b8f98]">{ioHint(side, schemaName)}</p>
    </div>
  );
}

function OpenIoField({
  field,
  onRename,
  onType,
  onRequired,
}: {
  field: IoField;
  onRename: (name: string) => void;
  onType: (type: IoFieldType) => void;
  onRequired: (required: boolean) => void;
}) {
  const name = useLocalText(field.name);
  function commit() {
    const next = name.text.trim();
    name.setEditing(false);
    if (!next || next === field.name) {
      name.setText(field.name);
      return;
    }
    onRename(next);
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] p-2">
      <input
        value={name.text}
        aria-label={`Name for ${field.name}`}
        onFocus={() => name.setEditing(true)}
        onChange={(event) => name.setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            name.setText(field.name);
            name.setEditing(false);
          }
        }}
        className={`h-[30px] rounded-lg border border-[#ffffff1a] bg-[#131418] px-2.5 text-xs text-[#ecedee] outline-none focus:border-[#ffffff33] ${MONO}`}
      />
      <IoTypeSelect
        value={field.type === "other" ? "other" : field.type}
        extra={field.type === "other" ? { value: "other", label: "custom" } : undefined}
        ariaLabel={`Type for ${field.name}`}
        onChange={onType}
      />
      <RequiredSwitch on={field.required} onChange={onRequired} />
    </div>
  );
}
