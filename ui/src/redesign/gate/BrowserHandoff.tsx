import { useEffect, useState } from "react";
import { LuCheck, LuMaximize2, LuMinimize2 } from "react-icons/lu";
import { LiveView } from "../../liveView/LiveView";

export const BROWSER_HANDOFF_DONE_LABEL = "I've logged in";
export const BROWSER_HANDOFF_HINT =
  "You control this browser. Click the page, then type. Press the button when you are done and the agent carries on.";

export function BrowserHandoff({
  handoffUrl,
  reopenKey,
  onDone,
  disabled,
  compact,
}: {
  handoffUrl: string;
  reopenKey: unknown;
  onDone: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggle = (
    <button
      type="button"
      className="bh__icon-btn"
      aria-label={expanded ? "Exit full screen" : "Full screen"}
      title={expanded ? "Exit full screen (Esc)" : "Full screen"}
      aria-pressed={expanded}
      onClick={() => setExpanded((v) => !v)}
    >
      {expanded ? <LuMinimize2 aria-hidden="true" /> : <LuMaximize2 aria-hidden="true" />}
    </button>
  );

  return (
    <div className={`bh${compact ? " bh--compact" : ""}`} data-expanded={expanded ? "true" : "false"}>
      {expanded ? <div className="bh__scrim" onClick={() => setExpanded(false)} aria-hidden="true" /> : null}
      <div className="bh__frame">
        <LiveView handoffUrl={handoffUrl} mode="control" reopenKey={reopenKey} variant="window" toolbarActions={toggle} />
        <div className="bh__footer">
          <p className="bh__hint">{BROWSER_HANDOFF_HINT}</p>
          {expanded ? (
            <button type="button" className="bh__done" disabled={disabled} onClick={onDone}>
              <LuCheck aria-hidden="true" />
              {BROWSER_HANDOFF_DONE_LABEL}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
