import { useEffect, useState } from "react";
import { LuFlaskConical } from "react-icons/lu";
import { fetchEvalRuns } from "../../api";
import { navigate } from "../../routes";
import { stageRunBannerModel, type StageRunBannerModel } from "./stageRunBannerModel";

export function StageRunEvalBanner({ runId }: { runId: string }) {
  const [banner, setBanner] = useState<StageRunBannerModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBanner(null);
    fetchEvalRuns({ stage_run_id: runId, limit: 1 }).then(
      (res) => {
        if (!cancelled) setBanner(stageRunBannerModel(res.items));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (!banner) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-b-[var(--sf-hairline)] bg-[var(--sf-raised)] px-6 py-2">
      <LuFlaskConical className="size-3.5 shrink-0 text-[var(--sf-text-2)]" aria-hidden />
      <span className="text-[13px] text-[var(--sf-text-2)]">{banner.text}</span>
      <button
        type="button"
        onClick={() => navigate(banner.href)}
        className="text-[13px] font-medium text-[var(--sf-text-1)] underline"
      >
        Open eval result
      </button>
    </div>
  );
}
