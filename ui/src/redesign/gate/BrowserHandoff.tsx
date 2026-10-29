import { useEffect, useState } from "react";
import { LuCheck, LuExternalLink, LuMaximize2, LuMinimize2 } from "react-icons/lu";
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

export function localWindowNote(own: boolean, site: string | undefined): { title: string; body: string } {
  const where = site !== undefined ? ` (${site})` : "";
  return own
    ? {
        title: "Use your own Chrome",
        body: `Stageflow is attached to the Chrome you started with a debugging port. Switch to that window and use the new tab it opened${where}. Stageflow never closes that browser.`,
      }
    : {
        title: "Use the browser window on this computer",
        body: `A browser window${where} is open on the machine running Stageflow. Switch to it to act, then answer here.`,
      };
}

export function LocalWindowNote({ own, site }: { own: boolean; site?: string }) {
  const note = localWindowNote(own, site);
  return (
    <div className="bh-note" role="note">
      <LuExternalLink className="bh-note__icon" aria-hidden="true" />
      <div>
        <div className="bh-note__title">{note.title}</div>
        <p className="bh-note__body">{note.body}</p>
      </div>
    </div>
  );
}
