import { LuDatabase, LuFlaskConical, LuLayers, LuListChecks, LuPlay } from "react-icons/lu";
import { EMPTY_BODY, EMPTY_STEPS, EMPTY_TITLE } from "./evalListModel";

const STEP_ICONS = [LuLayers, LuDatabase, LuListChecks];

export function EvalsEmptyState({
  busy,
  onTrySample,
  onCreate,
}: {
  busy: boolean;
  onTrySample: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]">
          <LuFlaskConical className="size-5 text-[var(--sf-text-1)]" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold tracking-[-0.2px] text-[var(--sf-text-1)]">{EMPTY_TITLE}</h2>
        <p className="max-w-[500px] text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{EMPTY_BODY}</p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onTrySample}
            className="flex h-9 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-4 text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-60"
          >
            <LuPlay className="size-3.5" aria-hidden />
            Try the sample eval
          </button>
          <button
            type="button"
            onClick={onCreate}
            className="flex h-9 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-4 text-[13px] font-medium text-[var(--sf-text-1)]"
          >
            Create your own
          </button>
        </div>
      </div>
      <div className="grid w-full max-w-[820px] grid-cols-3 gap-3">
        {EMPTY_STEPS.map((step, index) => {
          const Icon = STEP_ICONS[index]!;
          return (
            <div
              key={step.title}
              className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-4"
            >
              <Icon className="size-4 text-[var(--sf-text-2)]" aria-hidden />
              <p className="text-[13px] font-medium text-[var(--sf-text-1)]">{step.title}</p>
              <p className="text-xs leading-[1.5] text-[var(--sf-text-3)]">{step.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
