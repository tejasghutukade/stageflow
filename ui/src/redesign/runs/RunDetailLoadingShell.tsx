import { runShortId } from "../../catalogJoin";

export function RunDetailLoadingShell({
  runId,
  onBack,
}: {
  runId: string;
  onBack: () => void;
}) {
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <header className="flex w-full shrink-0 items-end justify-between gap-6 border-b border-b-[#ffffff12] px-6 py-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="font-sans text-xs text-[var(--sf-text-2)]"
              onClick={onBack}
            >
              Runs
            </button>
            <span className="text-[var(--sf-text-3)]">→</span>
            <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
              {runShortId(runId)}
            </span>
          </div>
          <div className="h-7 w-48 max-w-full animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="flex flex-wrap gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-[var(--sf-raised)]" />
            <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <div className="h-8 w-24 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
          <div className="h-8 w-28 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
        </div>
      </header>
      <div className="flex w-full shrink-0 flex-col border-b border-b-[#ffffff12] px-6 py-4">
        <div className="mb-3 h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="mb-2 flex h-8 items-center gap-4"
            aria-hidden="true"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-[var(--sf-raised)]" />
            <div className="h-2 min-w-0 flex-1 animate-pulse rounded bg-[var(--sf-raised)]" />
          </div>
        ))}
      </div>
      <div className="flex min-h-0 w-full flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-r-[#ffffff12]">
          <div className="h-10 shrink-0 border-b border-b-[#ffffff12] bg-[var(--sf-panel)]" />
          <div className="min-h-0 flex-1 bg-[var(--sf-ground)]" />
        </div>
        <div className="w-96 shrink-0 border-l border-l-[#ffffff12] bg-[var(--sf-panel)]" />
      </div>
    </div>
  );
}
