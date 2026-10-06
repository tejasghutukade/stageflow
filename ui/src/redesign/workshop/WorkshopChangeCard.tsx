import { useState } from "react";
import type { WorkshopChatProposalPayload } from "../../api";

export type WorkshopChangeCardProps = {
  summary: string;
  proposal?: WorkshopChatProposalPayload;
  stageIds: string[];
  status: "pending" | "accepted" | "rejected" | "conflict";
  notice?: string;
  locked: boolean;
  onAccept: () => void;
  onReject: () => void;
};

function lineDelta(before: string, after: string): { add: number; remove: number } {
  const b = before ? before.split("\n").length : 0;
  const a = after ? after.split("\n").length : 0;
  return { add: Math.max(0, a - b), remove: Math.max(0, b - a) };
}

export function WorkshopChangeCard({
  summary,
  proposal,
  stageIds,
  status,
  notice,
  locked,
  onAccept,
  onReject,
}: WorkshopChangeCardProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const artifacts = proposal?.artifacts ?? [];

  return (
    <div className="sf-change-card" data-status={status}>
      <div className="sf-change-card__head">
        <div className="sf-change-card__eyebrow">Draft mutation</div>
        <strong className="sf-change-card__title">{summary}</strong>
        {stageIds.length > 0 ? (
          <span className="sf-change-card__stages sf-mono">
            {stageIds.join(", ")}
          </span>
        ) : null}
      </div>
      {artifacts.length > 0 ? (
        <ul className="sf-change-card__files">
          {artifacts.map((artifact) => {
            const delta = lineDelta(
              artifact.before ?? "",
              artifact.after ?? "",
            );
            const expanded = openPath === artifact.path;
            return (
              <li key={artifact.path} className="sf-change-card__file">
                <button
                  type="button"
                  className="sf-change-card__file-btn"
                  onClick={() =>
                    setOpenPath(expanded ? null : artifact.path)
                  }
                >
                  <span className="sf-mono">{artifact.path}</span>
                  <span className="sf-change-card__delta">
                    +{delta.add} −{delta.remove}
                  </span>
                </button>
                {expanded ? (
                  <div className="sf-change-card__diff sf-mono">
                    <pre>{artifact.after || artifact.before}</pre>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {status === "pending" ? (
        <div className="sf-change-card__actions">
          <button
            type="button"
            className="sf-btn sf-btn--primary sf-btn--sm"
            disabled={locked}
            onClick={onAccept}
          >
            Accept
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--ghost sf-btn--sm"
            disabled={locked}
            onClick={onReject}
          >
            Reject
          </button>
        </div>
      ) : (
        <p className="sf-change-card__status">
          {status === "accepted"
            ? "Accepted"
            : status === "rejected"
              ? "Rejected · undone"
              : (notice ?? "Could not undo")}
        </p>
      )}
    </div>
  );
}
