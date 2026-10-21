import { useEffect, useState } from "react";
import { fetchEval } from "../../../api";
import { evalEditPath, evalRunPath, evalsPath, navigate } from "../../../routes";
import { PageHeader } from "../../shell/PageHeader";

export function EvalDetailRedirect({ evalId }: { evalId: string }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEval(evalId).then(
      (detail) => {
        if (cancelled) return;
        const hash = detail.runs_count > 0 && detail.last_run ? evalRunPath(evalId, detail.last_run.run_number) : evalEditPath(evalId);
        window.location.replace(`#${hash}`);
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
