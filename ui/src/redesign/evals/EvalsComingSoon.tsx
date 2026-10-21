import { navigate, evalsPath } from "../../routes";
import { PageHeader } from "../shell/PageHeader";

export function EvalsComingSoon({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader title={title} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12">
        <p className="text-[13px] text-[var(--sf-text-2)]">Coming soon.</p>
        <button
          type="button"
          onClick={() => navigate(evalsPath())}
          className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)]"
        >
          Back to Evals
        </button>
      </div>
    </div>
  );
}
