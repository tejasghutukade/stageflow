import type { ReactNode } from "react";
import type { ValidationFinding } from "../../api";
import { ProblemsPanel } from "../ProblemsPanel";

export type WorkshopWorkspaceProps = {
  mapHead: ReactNode;
  mapBody: ReactNode;
  inspector: ReactNode;
  bottomTab: "problems";
  findings: ValidationFinding[];
  validating: boolean;
  validateError: string | null;
  onValidate: () => void;
};

export function WorkshopWorkspace({
  mapHead,
  mapBody,
  inspector,
  findings,
  validating,
  validateError,
  onValidate,
}: WorkshopWorkspaceProps) {
  return (
    <section
      className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(240px,320px)] grid-rows-[minmax(0,1fr)_auto]"
      aria-label="Workshop studio"
    >
      <div className="flex min-h-0 min-w-0 flex-col border-r border-r-[#ffffff12]">
        <div className="shrink-0 border-b border-b-[#ffffff12] px-3.5 py-2">
          {mapHead}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{mapBody}</div>
      </div>
      <div className="min-h-0 overflow-auto">{inspector}</div>
      <div className="col-span-2 min-h-0 border-t border-t-[#ffffff12] bg-[var(--sf-panel)]">
        <ProblemsPanel
          findings={findings}
          loading={validating}
          error={validateError}
          onValidate={onValidate}
        />
      </div>
    </section>
  );
}
