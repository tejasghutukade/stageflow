import { hiddenSummary, hiddenTotal, type HiddenInProject } from "./otherProjects";

export function OtherProjectsNote({
  hidden,
  scopeLabel,
  onSwitch,
  onReset,
}: {
  hidden: readonly HiddenInProject[];
  scopeLabel?: string | undefined;
  onSwitch: (root: string) => void;
  onReset: () => void;
}) {
  if (scopeLabel === undefined && hiddenTotal(hidden) === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-4 py-2.5 text-[13px] leading-normal text-[var(--sf-text-2)]"
      data-testid="other-projects-note"
    >
      {scopeLabel !== undefined ? (
        <>
          <span>Showing only {scopeLabel}.</span>
          <button type="button" onClick={onReset} className="text-[var(--sf-text-1)] underline">
            Back to the default project
          </button>
        </>
      ) : null}
      {hiddenTotal(hidden) > 0 ? (
        <>
          <span>{hiddenSummary(hidden)}:</span>
          {hidden.map((h) => (
            <button
              key={h.root}
              type="button"
              onClick={() => onSwitch(h.root)}
              className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-0.5 text-xs text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]"
            >
              {h.label} ({h.count})
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
