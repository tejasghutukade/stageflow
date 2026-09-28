import {
  formatArtifactDiffLine,
  type ChatMessage,
  type ProposalArtifactDiff,
  type WorkshopProposal,
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

export type WorkshopChatPanelProps = {
  messages: ChatMessage[];
  pending: WorkshopProposal | null;
  busy: boolean;
  autoApply: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onAccept: () => void;
  onReject: () => void;
};

export function WorkshopChatPanel({
  messages,
  pending,
  busy,
  input,
  onInputChange,
  onSend,
}: WorkshopChatPanelProps) {
  return (
    <section className="workshop__chat" aria-label="Workshop Author chat">
      <div className="eyebrow">Workshop Author</div>
      <div className="workshop__transcript">
        {messages.map((m) => (
          <div key={m.id} className="workshop__bubble" data-role={m.role}>
            <div className="eyebrow">{m.role}</div>
            <p>{m.text}</p>
            {m.artifacts ? <ArtifactDiffList artifacts={m.artifacts} /> : null}
          </div>
        ))}
      </div>
      <form
        className="workshop__composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <input
          className="input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={
            pending
              ? "Accept or Reject the pending proposal first"
              : "Describe a stage, task, or workflow…"
          }
          disabled={busy || Boolean(pending)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || Boolean(pending) || !input.trim()}
        >
          Send
        </button>
      </form>
    </section>
  );
}
