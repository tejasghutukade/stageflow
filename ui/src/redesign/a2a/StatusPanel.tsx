import { useState } from "react";
import type { A2aStatus } from "../../api/a2a";
import { CARD, CopyButton, DANGER, GHOST, MONO, SECONDARY, StatusLabel } from "../identity/identityParts";
import { agentCardCommand, callingAgentSnippet, failedReload, relativeAt } from "./a2aView";

export function StatusPanel({
  status,
  busy,
  now,
  onReload,
  onDisable,
}: {
  status: A2aStatus;
  busy: boolean;
  now: number;
  onReload: () => void;
  onDisable: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const snippet = callingAgentSnippet(status.agentCardUrl);
  const reload = status.lastReload;
  return (
    <div className="flex flex-col gap-6">
      <div className={`${CARD} flex flex-col gap-3 px-4 py-4`}>
        <StatusLabel
          tone={failedReload(status) ? "fail" : "ok"}
          label={failedReload(status) ? "A2A is on, but the last reload failed" : "A2A is on"}
          detail={`${status.callers} ${status.callers === 1 ? "caller" : "callers"}, ${status.publications} published ${status.publications === 1 ? "pipeline" : "pipelines"}`}
        />
        <dl className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-[#8b8f98]">Configuration file</dt>
            <dd className={`min-w-0 break-all text-right text-[13px] text-[#ecedee] ${MONO}`}>{status.configPath || "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-[#8b8f98]">Last load</dt>
            <dd className="min-w-0 text-right text-[13px] text-[#ecedee]">
              {reload ? `${reload.ok ? "Loaded" : "Failed"} ${relativeAt(reload.at, now)}` : "At startup"}
            </dd>
          </div>
          {reload && !reload.ok && reload.error ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-xs text-[#8b8f98]">Why it failed</dt>
              <dd className={`min-w-0 break-words text-right text-xs text-[#f2645a] ${MONO}`}>{reload.error.message}</dd>
            </div>
          ) : null}
        </dl>
        <div>
          <button type="button" className={SECONDARY} disabled={busy} onClick={onReload}>Reload configuration</button>
        </div>
      </div>

      <div className={`${CARD} flex flex-col gap-3 px-4 py-4`}>
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium text-[#ecedee]">For the calling agent</h3>
          <p className="text-xs leading-[1.5] text-[#8b8f98]">
            Give the calling agent the agent card address and the token you copied when you added it. The token is not shown here.
          </p>
        </div>
        <pre className={`overflow-auto whitespace-pre-wrap break-all rounded-md border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs text-[#ecedee] ${MONO}`} data-testid="a2a-snippet">{snippet}</pre>
        <div className="flex items-center gap-2">
          <CopyButton value={snippet} label="Copy snippet" />
          <CopyButton value={agentCardCommand(status.agentCardUrl)} label="Copy command" />
        </div>
      </div>

      <div className={`${CARD} flex flex-col gap-3 px-4 py-4`}>
        <h3 className="text-[13px] font-medium text-[#ecedee]">Turn off A2A</h3>
        <p className="text-xs leading-[1.5] text-[#8b8f98]">
          Other agents can no longer reach this Host over A2A. Callers, published pipelines and tokens are kept; turning A2A on again restores them.
        </p>
        {confirming ? (
          <div className="flex items-center gap-2">
            <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirming(false); onDisable(); }}>Yes, turn off A2A</button>
            <button type="button" className={GHOST} onClick={() => setConfirming(false)}>Keep it on</button>
          </div>
        ) : (
          <div>
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirming(true)}>Turn off A2A</button>
          </div>
        )}
      </div>
    </div>
  );
}
