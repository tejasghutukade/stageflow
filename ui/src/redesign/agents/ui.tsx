import { useEffect, useId, useState, type ReactNode } from "react";
import { MONO, NOWRAP } from "./agentsTokens";

/** Shared Agents-page atoms, transcribed from the Wonder agent artboards. */

export type Crumb = { label: string; onClick?: () => void };

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="flex items-center text-xs leading-[1.33333] text-[var(--sf-text-3)]" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex items-center">
          {index > 0 ? <span className="px-1">/</span> : null}
          {item.onClick ? (
            <button type="button" onClick={item.onClick} className="hover:text-[var(--sf-text-2)]">
              {item.label}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  crumbs,
  title,
  titleExtras,
  description,
  actions,
  meta,
  roomy = false,
}: {
  crumbs: Crumb[];
  title: ReactNode;
  titleExtras?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  /** Detail pages use py-5/gap-5 and a looser title stack. */
  roomy?: boolean;
}) {
  return (
    <header
      className={`flex shrink-0 flex-col border-b border-b-[var(--sf-hairline)] px-7 ${
        roomy ? "gap-5 py-5" : "gap-3 pb-4 pt-5"
      }`}
    >
      <Breadcrumb items={crumbs} />
      <div className="flex items-center justify-between gap-6">
        <div className={`flex min-w-0 flex-1 flex-col ${roomy ? "gap-2" : "gap-1.5"}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <h1
              className={`truncate text-2xl font-semibold tracking-[-0.5px] text-[var(--sf-text-1)] ${
                roomy ? "leading-normal" : "leading-[1.33333]"
              }`}
            >
              {title}
            </h1>
            {titleExtras}
          </div>
          {description ? <div className="text-[13px] leading-normal text-[var(--sf-text-2)]">{description}</div> : null}
          {meta}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function PageFooter({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <footer className="flex h-11 shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] px-7">
      <span className="truncate text-xs leading-[1.33333] text-[var(--sf-text-3)]">{left}</span>
      {right ? <span className="shrink-0 text-xs leading-[1.33333] text-[var(--sf-text-3)]">{right}</span> : null}
    </footer>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-[var(--sf-text-1)] text-[var(--sf-ground)]",
  secondary:
    "border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] text-[var(--sf-text-1)] hover:bg-[#20232a]",
  ghost: "font-normal text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]",
};

export function Button({
  variant = "secondary",
  icon,
  children,
  onClick,
  disabled,
  type = "button",
  title,
  size = "md",
}: {
  variant?: ButtonVariant;
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  size?: "md" | "sm";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex shrink-0 items-center justify-center font-medium leading-normal disabled:cursor-not-allowed disabled:opacity-50 ${NOWRAP} ${
        size === "sm" ? "h-7 gap-1.5 rounded-md px-2.5 text-xs" : "h-8 gap-1.5 rounded-lg px-3 text-[13px]"
      } ${BUTTON[variant]}`}
    >
      {icon ? <span className={`flex shrink-0 ${size === "sm" ? "[&>svg]:size-3" : "[&>svg]:size-3.5"}`}>{icon}</span> : null}
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange?: (next: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange ? () => onChange(!on) : undefined}
      className={`flex h-[18px] w-8 shrink-0 items-center rounded-full px-0.5 ${
        on
          ? "justify-end bg-[var(--sf-running)]"
          : "justify-start border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)]"
      }`}
    >
      <span className={`block size-3 rounded-full ${on ? "bg-white" : "bg-[var(--sf-text-3)]"}`} />
    </button>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  changed = false,
  className = "",
}: {
  options: string[];
  value: string;
  onChange?: (value: string) => void;
  changed?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={`flex h-9 items-center rounded-lg border bg-[var(--sf-panel)] p-0.5 ${
        changed ? "border-[#6ca6ff66]" : "border-[var(--sf-hairline-strong)]"
      } ${className}`}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={onChange ? () => onChange(option) : undefined}
            className={`flex h-full flex-1 items-center justify-center rounded-md text-[13px] leading-normal ${
              active ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function SectionHeading({ children, note, aside }: { children: ReactNode; note?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">{children}</h2>
        {note ? <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{note}</p> : null}
      </div>
      {aside}
    </div>
  );
}

export function Field({
  label,
  hint,
  hintTone = "muted",
  changed = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  hintTone?: "muted" | "ok" | "changed";
  changed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{label}</span>
        {changed ? <ChangedDot /> : null}
      </div>
      {children}
      {hint ? (
        <div
          className={`text-xs leading-[1.33333] ${
            hintTone === "ok"
              ? "text-[var(--sf-ok)]"
              : hintTone === "changed"
                ? "text-[var(--sf-running)]"
                : "text-[var(--sf-text-3)]"
          }`}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function TextBox({
  value,
  onChange,
  placeholder,
  mono = false,
  changed = false,
  invalid = false,
  readOnly = false,
  trailing,
  ariaLabel,
}: {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  changed?: boolean;
  invalid?: boolean;
  /** Visually locked (e.g. the id after creation). Without onChange the box is also read-only. */
  readOnly?: boolean;
  trailing?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <label className={`flex h-9 items-center justify-between gap-2 rounded-lg border px-3 ${frameTone({ changed, invalid, readOnly })}`}>
      <input
        value={value}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || !onChange}
        placeholder={placeholder}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className={`min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-normal outline-none placeholder:text-[var(--sf-text-3)] ${
          readOnly ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"
        } ${mono ? MONO : ""}`}
      />
      {trailing}
    </label>
  );
}

export function ChangedDot() {
  return <span className="block size-1.5 shrink-0 rounded-full bg-[var(--sf-running)]" aria-label="Changed" />;
}

/** Bordered list group; rows separate with hairlines. */
export function ListGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-[var(--sf-hairline)] [&>*+*]:border-t [&>*+*]:border-t-[var(--sf-hairline)]">
      {children}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  aside,
  height = "h-[46px]",
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  aside?: ReactNode;
  height?: string;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-b-[var(--sf-hairline)] px-7">
      <div className="flex items-center gap-6" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.id)}
              className={`flex ${height} items-center text-[13px] leading-normal ${
                active
                  ? "border-b-2 border-b-[var(--sf-text-1)] font-medium text-[var(--sf-text-1)]"
                  : "border-b-2 border-b-transparent text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {aside}
    </div>
  );
}

export function Stat({
  label,
  value,
  detail,
  valueClassName = "text-[var(--sf-text-1)]",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs leading-normal text-[var(--sf-text-3)]">{label}</span>
      <span className={`${MONO} text-xl font-medium leading-normal ${valueClassName}`}>{value}</span>
      {detail ? <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{detail}</span> : null}
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-xs leading-normal">
      <span className="text-[var(--sf-text-3)]">{label}</span>
      <span className="text-right text-[var(--sf-text-1)]">{value}</span>
    </div>
  );
}

/* ---------- form controls ---------- */

const CONTROL_FRAME = "flex h-9 items-center rounded-lg border px-3";

function frameTone(state: { changed?: boolean; invalid?: boolean; readOnly?: boolean }): string {
  if (state.invalid) return "border-[#f2645a80] bg-[var(--sf-panel)]";
  if (state.changed) return "border-[#6ca6ff66] bg-[var(--sf-panel)]";
  if (state.readOnly) return "border-[var(--sf-hairline)]";
  return "border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]";
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  mono = false,
  changed = false,
  invalid = false,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange?: (value: T) => void;
  disabled?: boolean;
  mono?: boolean;
  changed?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  return (
    <label className={`${CONTROL_FRAME} relative justify-between gap-2 ${frameTone({ changed, invalid, readOnly: !onChange })}`}>
      <select
        value={value}
        aria-label={ariaLabel}
        disabled={disabled || !onChange}
        onChange={onChange ? (event) => onChange(event.target.value as T) : undefined}
        className={`min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 pr-5 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none disabled:cursor-default ${mono ? MONO : ""}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[var(--sf-panel)]">
            {option.label}
          </option>
        ))}
      </select>
      <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute right-3 size-3.5 stroke-[var(--sf-text-3)]" fill="none" strokeWidth="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </label>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  placeholder,
  changed = false,
  invalid = false,
  ariaLabel,
}: {
  value: number | null;
  onChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  changed?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== "" ? current : value === null ? "" : String(value)));
  }, [value]);
  return (
    <label className={`${CONTROL_FRAME} gap-2 ${frameTone({ changed, invalid, readOnly: !onChange })}`}>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        aria-label={ariaLabel}
        readOnly={!onChange}
        onChange={(event) => {
          setText(event.target.value);
          if (!onChange) return;
          const raw = event.target.value.trim();
          onChange(raw === "" ? null : Number(raw));
        }}
        className={`${MONO} min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none`}
      />
      {suffix ? <span className="shrink-0 text-xs text-[var(--sf-text-3)]">{suffix}</span> : null}
    </label>
  );
}

/** Editable list of short strings (tool names, skills, patterns). Enter or comma adds; × removes. */
export function ChipListField({
  values,
  onChange,
  placeholder,
  suggestions = [],
  mono = true,
  ariaLabel,
}: {
  values: string[];
  onChange?: (values: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  mono?: boolean;
  ariaLabel?: string;
}) {
  const [input, setInput] = useState("");
  const listId = useId();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || !onChange || values.includes(value)) return;
    onChange([...values, value]);
    setInput("");
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 py-1.5">
      {values.map((value) => (
        <span
          key={value}
          className={`flex items-center gap-1 rounded-md bg-[var(--sf-raised)] px-1.5 py-0.5 text-xs leading-[1.33333] text-[var(--sf-text-1)] ${mono ? MONO : ""}`}
        >
          {value}
          {onChange ? (
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((item) => item !== value))}
              className="text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {onChange ? (
        <>
          <input
            value={input}
            list={suggestions.length > 0 ? listId : undefined}
            aria-label={ariaLabel}
            placeholder={values.length === 0 ? placeholder : undefined}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add(input);
              } else if (event.key === "Backspace" && input === "" && values.length > 0) {
                onChange(values.slice(0, -1));
              }
            }}
            onBlur={() => add(input)}
            className={`min-w-[120px] flex-1 border-0 bg-transparent p-0 text-xs leading-[1.33333] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)] ${mono ? MONO : ""}`}
          />
          {suggestions.length > 0 ? (
            <datalist id={listId}>
              {suggestions
                .filter((item) => !values.includes(item))
                .map((item) => (
                  <option key={item} value={item} />
                ))}
            </datalist>
          ) : null}
        </>
      ) : values.length === 0 ? (
        <span className="text-xs text-[var(--sf-text-3)]">None</span>
      ) : null}
    </div>
  );
}

/** Field-level validation messages (red) and warnings (amber). */
export function FieldMessages({ issues = [], warnings = [] }: { issues?: Array<{ message: string }>; warnings?: Array<{ message: string }> }) {
  if (issues.length === 0 && warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {issues.map((issue, index) => (
        <span key={`i${index}`} className="text-xs leading-[1.33333] text-[var(--sf-fail)]">
          {issue.message}
        </span>
      ))}
      {warnings.map((warning, index) => (
        <span key={`w${index}`} className="text-xs leading-[1.33333] text-[var(--sf-needs)]">
          {warning.message}
        </span>
      ))}
    </div>
  );
}
