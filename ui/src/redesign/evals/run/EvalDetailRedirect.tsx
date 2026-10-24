import { useEffect, useState } from "react";
import { fetchEval, fetchEvalRuns } from "../../../api";
import { evalEditPath, evalRunPath, evalsPath, navigate } from "../../../routes";
import { evalLandingTarget, newestRunNumber } from "./runSwitcherModel";
import { PageHeader } from "../../shell/PageHeader";

export function EvalDetailRedirect({ evalId }: { evalId: string }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const go = (hash: string) => {
      if (!cancelled) window.location.replace(`#${hash}`);
    };
    fetchEval(evalId).then(
      async (detail) => {
        if (cancelled) return;
        let newest: number | null = null;
        if (!detail.active_run && detail.runs_count > 0) {
          newest = await fetchEvalRuns({ eval_id: evalId, limit: 200 }).then(
            (page) => newestRunNumber(page.items.map((item) => item.run_number)),
            () => null,
          );
        }
        const target = evalLandingTarget({ ...detail, newestRunNumber: newest });
        go(target.kind === "run" ? evalRunPath(evalId, target.runNumber) : evalEditPath(evalId));
      },
      (err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalId]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader title={evalId} crumbs={[{ label: "Evals", onClick: () => navigate(evalsPath()) }]} />
      <p className={`px-5 py-4 text-xs ${error ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`} role={error ? "alert" : undefined}>
        {error ?? "Opening…"}
      </p>
    </div>
  );
}
