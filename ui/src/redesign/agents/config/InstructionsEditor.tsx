import { MONO } from "../agentsTokens";

const TEXT = `${MONO} text-xs leading-[24px] whitespace-pre-wrap break-words`;

/**
 * Mono playbook editor from the agent artboards. Lines missing from `baseline`
 * get the blue "added" bar, drawn on a backdrop under a transparent textarea.
 */
export function InstructionsEditor({
  value,
  onChange,
  baseline,
  placeholder,
  minRows = 7,
}: {
  value: string;
  onChange?: (value: string) => void;
  baseline?: string;
  placeholder?: string;
  minRows?: number;
}) {
  const lines = value.split("\n");
  const before = baseline === undefined ? null : new Set(baseline.split("\n"));
  const rows = Math.max(minRows, lines.length);
  return (
    <div className="relative rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3.5 py-3">
      <div aria-hidden className={`${TEXT} pointer-events-none absolute inset-x-3.5 top-3 text-transparent`}>
        {lines.map((line, index) => {
          const added = before !== null && line.trim() !== "" && !before.has(line);
          return (
            <div
              key={index}
              className={added ? "-mx-3.5 bg-[#6ca6ff14] px-3.5 shadow-[inset_2px_0_0_var(--sf-running)]" : undefined}
            >
              {line || " "}
            </div>
          );
        })}
      </div>
      <textarea
        value={value}
        rows={rows}
        readOnly={!onChange}
        placeholder={placeholder}
        aria-label="Instructions"
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className={`${TEXT} relative block w-full resize-none border-0 bg-transparent p-0 text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]`}
      />
    </div>
  );
}

export function addedLineCount(value: string, baseline: string): number {
  const before = new Set(baseline.split("\n"));
  return value.split("\n").filter((line) => line.trim() !== "" && !before.has(line)).length;
}
