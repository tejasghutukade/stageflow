import { useId, useState } from "react";
import { LuX } from "react-icons/lu";
import { MONO } from "./parts";

type Props = {
  values: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  suggestions?: readonly string[];
  /** Highlights chips that fail a check, for example a tool the agent does not have. */
  flag?: (value: string) => boolean;
};

export function ChipInput({ values, onChange, label, placeholder, suggestions = [], flag }: Props) {
  const [text, setText] = useState("");
  const listId = useId();

  function commit(raw: string) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "" && !values.includes(p));
    setText("");
    if (parts.length > 0) onChange([...values, ...parts]);
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-1">
      {values.map((v) => (
        <span
          key={v}
          className={`${MONO} flex items-center gap-1 rounded border px-1.5 py-px text-xs ${
            flag?.(v) ? "border-[#e5a50a55] text-[var(--sf-warn,#e5a50a)]" : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-1)]"
          }`}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]"
          >
            <LuX className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        list={suggestions.length > 0 ? listId : undefined}
        className={`${MONO} h-6 min-w-[120px] flex-1 border-0 bg-transparent text-xs text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]`}
        value={text}
        placeholder={values.length === 0 ? placeholder : undefined}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) commit(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          } else if (e.key === "Backspace" && text === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(text)}
      />
      {suggestions.length > 0 ? (
        <datalist id={listId}>
          {suggestions.filter((s) => !values.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
