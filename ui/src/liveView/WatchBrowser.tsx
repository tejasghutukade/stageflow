import { LiveView } from "./LiveView";
import { watchBrowserUrl } from "./handoff";
import { WATCH_CLOSE_LABEL } from "./helpText";

export function WatchBrowserPanel({
  runId,
  stageId,
  onClose,
}: {
  runId: string;
  stageId: string;
  onClose(): void;
}) {
  return (
    <aside className="watch-browser" aria-label="Watch browser">
      <button type="button" className="btn btn--sm watch-browser__close" onClick={onClose}>
        {WATCH_CLOSE_LABEL}
      </button>
      <LiveView key={`${runId}/${stageId}`} handoffUrl={watchBrowserUrl(runId, stageId)} mode="view" />
    </aside>
  );
}
