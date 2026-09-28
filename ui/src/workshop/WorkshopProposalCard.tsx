import {
  formatArtifactDiffLine,
  type ProposalArtifactDiff,
} from "./draft";

export function ArtifactDiffList({
  artifacts,
}: {
  artifacts: ProposalArtifactDiff[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <ul className="workshop__diff-list" aria-label="Per-artifact diff">
      {artifacts.map((diff) => (
        <li key={`${diff.kind}-${diff.path}`}>
          {formatArtifactDiffLine(diff)}
          {diff.after || diff.before ? (
            <pre>{diff.after ?? diff.before}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function WorkshopProposalCard({
  summary,
  artifacts,
  interactive,
  onAccept,
  onReject,
}: {
  summary: string;
  artifacts: ProposalArtifactDiff[];
  interactive: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div
      className="workshop__proposal workshop__proposal--thread"
      role="group"
      aria-label={interactive ? "Pending proposal" : "Proposal"}
    >
      <div className="eyebrow">
        {interactive ? "Pending proposal" : "Proposal"}
      </div>
      <p>{summary}</p>
      <ArtifactDiffList artifacts={artifacts} />
      {interactive ? (
        <div className="workshop__proposal-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onAccept}
          >
            Accept
          </button>
          <button type="button" className="btn" onClick={onReject}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}
