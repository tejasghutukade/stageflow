import { useEffect, useState } from "react";
import { LuFlaskConical } from "react-icons/lu";
import { fetchEvalRuns } from "../../api";
import { navigate } from "../../routes";
import { agentSessionBannerModel, type AgentSessionBannerModel } from "./agentSessionBannerModel";

/** Shown only for sessions an eval created; normal sessions render nothing and make no request. */
export function AgentSessionEvalBanner({ sessionId, source }: { sessionId: string; source: string | undefined }) {
  const [banner, setBanner] = useState<AgentSessionBannerModel | null>(null);
  const isEval = source === "eval";

  useEffect(() => {
    setBanner(null);
    if (!isEval) return;
    let cancelled = false;
    fetchEvalRuns({ subject_ref: sessionId, limit: 1 }).then(
      (res) => {
        if (!cancelled) setBanner(agentSessionBannerModel(res.items));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, isEval]);

  if (!banner) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-b-[var(--sf-hairline)] bg-[var(--sf-raised)] px-7 py-2">
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
