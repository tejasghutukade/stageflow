import { useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import type {
  StageVerificationAttempt,
  StageVerificationHistory,
  VerificationCheckResult,
} from "../api";

function checkStatusCopy(status: VerificationCheckResult["status"]): string {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

export function verificationAttemptCopy(attempt: StageVerificationAttempt): string {
  const suffix = attempt.checks.length === 1 ? "check" : "checks";
  return `Attempt ${attempt.attempt} · ${attempt.status} · verification ${attempt.verification_outcome.replace("_", " ")} · ${attempt.checks.length} ${suffix}`;
}

function VerificationCheck({ check }: { check: VerificationCheckResult }) {
  const evidence = check.evidence === undefined
    ? undefined
    : JSON.stringify(check.evidence, null, 2);

  return (
    <div className="verification-check">
      <div className="verification-check__summary">
        <span className={`status status--${check.status === "passed" ? "succeeded" : check.status === "failed" ? "failed" : "running"}`}>
          <span className={`dot dot--${check.status === "passed" ? "succeeded" : check.status === "failed" ? "failed" : "running"}`}></span>
          {" "}{checkStatusCopy(check.status)}
        </span>
        <code>{check.check_id}</code>
        <span className="muted">{check.check_type}</span>
      </div>
      {evidence !== undefined ? (
        <CodeBlock
          code={evidence}
          language="json"
          title="Evidence"
          size="sm"
          width="100%"
          maxHeight={260}
          container="section"
          isCollapsible
        />
      ) : null}
    </div>
  );
}

export function VerificationHistory({
  history,
  error,
  recovering = false,
  onRecover,
  onStop,
}: {
  history: StageVerificationHistory | null;
  error?: string | null;
  recovering?: boolean;
  onRecover?: (guidance: string) => void;
  onStop?: () => void;
}) {
  const [guidance, setGuidance] = useState("");
  if (error) {
    return <div className="banner banner--warning">Verification evidence unavailable: {error}</div>;
  }
  if (history === null || history.attempts.every((attempt) => attempt.checks.length === 0)) {
    return null;
  }

  return (
    <section className="verification-history" aria-label="Verification history">
      <div className="verification-history__head">
        <strong>Verification</strong>
        <span className="muted">{history.attempts.length} attempts</span>
      </div>
      {history.attempts.map((attempt) => (
        <Collapsible
          key={attempt.attempt}
          trigger={<span className="verification-history__attempt">{verificationAttemptCopy(attempt)}</span>}
          defaultIsOpen={attempt.attempt === history.attempts.length}
        >
          <div className="verification-history__checks">
            {attempt.checks.length > 0 ? (
              attempt.checks.map((check) => (
                <VerificationCheck key={check.check_id} check={check} />
              ))
            ) : (
              <p className="muted">No completion checks ran in this attempt.</p>
            )}
          </div>
        </Collapsible>
      ))}
      {history.manual_recovery?.status === "available" ? (
        <section className="manual-recovery" aria-label="Manual recovery">
          <strong>Manual recovery required</strong>
          <p className="muted">
            This stage remains failed until an operator explicitly retries it or stops recovery.
          </p>
          <label className="manual-recovery__label" htmlFor="manual-recovery-guidance">
            Guidance for the retry (optional)
          </label>
          <textarea
            id="manual-recovery-guidance"
            className="manual-recovery__guidance"
            value={guidance}
            maxLength={4000}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="Tell the agent what to address before it retries."
            disabled={recovering}
          />
          <div className="manual-recovery__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={recovering || onRecover === undefined}
              onClick={() => onRecover?.(guidance)}
            >
              {recovering ? "Starting recovery…" : "Retry with guidance"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--reject"
              disabled={recovering || onStop === undefined}
              onClick={() => onStop?.()}
            >
              Stop recovery
            </button>
          </div>
        </section>
      ) : null}
      {history.manual_recovery?.status === "stopped" ? (
        <p className="muted">Manual recovery was stopped by an operator.</p>
      ) : null}
    </section>
  );
}
