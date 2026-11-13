import type { ReactNode } from "react";
import { LuTriangleAlert, LuX } from "react-icons/lu";
import type { FunctionIssue } from "../../api/functions";
import { MONO } from "../agents/agentsTokens";

/** Multi-line control framed like the Agents TextBox, for JSON and other code-shaped text. */
export function CodeArea({
  value,
  onChange,
  ariaLabel,
  rows = 6,
  invalid = false,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  rows?: number;
  invalid?: boolean;
  placeholder?: string;
}) {
  return (
    <textarea
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      value={value}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${MONO} w-full resize-y rounded-lg border bg-[var(--sf-panel)] px-3 py-2 text-xs leading-[1.6] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)] focus:border-[var(--sf-text-3)] ${
        invalid ? "border-[#f2645a80]" : "border-[var(--sf-hairline-strong)]"
      }`}
    />
  );
}

export function IconButton({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-text-1)] focus-visible:bg-[var(--sf-raised)] focus-visible:text-[var(--sf-text-1)] focus-visible:outline-none [&>svg]:size-3.5 ${className}`}
    >
      {children}
    </button>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconButton label={label} onClick={onClick}>
      <LuX aria-hidden />
    </IconButton>
  );
}

export function issuesAt(issues: readonly FunctionIssue[], ...keys: string[]): FunctionIssue[] {
  return issues.filter((issue) => keys.some((key) => issue.path === key || issue.path.startsWith(`${key}[`) || issue.path.startsWith(`${key}.`)));
}

export function Callout({ tone, children, role }: { tone: "fail" | "needs"; children: ReactNode; role?: "alert" }) {
  const palette =
    tone === "fail"
      ? "border-[#f2645a80] bg-[var(--sf-fail-bg)]"
      : "border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)]";
  const icon = tone === "fail" ? "text-[var(--sf-fail)]" : "text-[var(--sf-needs)]";
  return (
    <div
      role={role}
      className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] leading-normal text-[var(--sf-text-1)] ${palette}`}
    >
      <LuTriangleAlert aria-hidden className={`mt-0.5 size-4 shrink-0 ${icon}`} />
      <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
    </div>
  );
}
