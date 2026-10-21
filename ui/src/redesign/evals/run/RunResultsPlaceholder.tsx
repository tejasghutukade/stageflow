import { LuPlay, LuTriangleAlert } from "react-icons/lu";
import type { EvalRunDetail } from "../../../api/evalTypes";
import { evalsPath, navigate } from "../../../routes";
import { PageHeader } from "../../shell/PageHeader";
import { incompleteBanner } from "./liveProgressModel";
import { openRunDialog } from "./runDialogStore";

/** Stand-in for the finished-run results screen; story 20 replaces this component. */
export function RunResultsPlaceholder({ run }: { run: EvalRunDetail }) {
  const banner = incompleteBanner(run);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={run.eval_id}
        subtitle={`Run #${run.run_number} · ${run.status.replace("_", " ")}`}
        crumbs={[{ label: "Evals", onClick: () => navigate(evalsPath()) }]}
        actions={
          <button
            type="button"
            onClick={() => openRunDialog(run.eval_id)}
            className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
          >
            <LuPlay className="size-3.5" aria-hidden />
            Run again
          </button>
        }
      />
      <div className="flex flex-col gap-4 px-5 py-4">
        {banner ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border px-4 py-3"
            style={{
              borderColor: `color-mix(in srgb, var(--sf-${banner.tone}) 30%, transparent)`,
              background: `var(--sf-${banner.tone}-bg)`,
            }}
          >
            <LuTriangleAlert className="size-4 shrink-0" style={{ color: `var(--sf-${banner.tone})` }} aria-hidden />
            <span className="text-[13px] text-[var(--sf-text-1)]">{banner.text}</span>
          </div>
        ) : null}
        <p className="text-[13px] text-[var(--sf-text-2)]">Results for this run are coming soon.</p>
      </div>
    </div>
  );
}
