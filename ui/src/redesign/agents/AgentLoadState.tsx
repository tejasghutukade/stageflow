import { LuTriangleAlert } from "react-icons/lu";
import type { AgentDetail } from "../../api/agents";
import { agentsPath, navigate } from "../../routes";
import { MONO, PAGE_BG } from "./agentsTokens";
import { PageHeader } from "../shell/PageHeader";
import { MISSING_COPY, missingKind, type MissingKind } from "./model/resourceState";
import { Button } from "./ui";

/** Shell for an agent page that has nothing to show yet: loading, missing, failed, or a file that doesn't parse. */
export function AgentLoadError({
  loading,
  error,
  invalid,
  kind = "agent",
  missing: missingOverride,
  onBack,
}: {
  loading: boolean;
  error: Error | null;
  invalid?: AgentDetail;
  /** What the page was loading, so a 404 names the right thing. */
  kind?: MissingKind;
  /** Force the not-found state, e.g. a run absent from a session that did load. */
  missing?: MissingKind | null;
  /** Where "back" goes when the thing is missing; defaults to the agents list. */
  onBack?: () => void;
}) {
  const missing = missingOverride ?? missingKind(error, kind);
  const copy = missing ? MISSING_COPY[missing] : null;
  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[{ label: "Agents", onClick: () => navigate(agentsPath()) }, ...(invalid ? [{ label: invalid.agent.id }] : [])]}
        title={invalid ? invalid.agent.id : copy ? copy.title : loading ? "Loading…" : "Agent"}
      />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
        {invalid ? (
          <div className="flex max-w-xl flex-col gap-3 text-left">
            <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--sf-needs)]">
              <LuTriangleAlert aria-hidden className="size-4" />
              agents/{invalid.agent.id}.agent.yaml has no valid version yet
            </p>
            <ul className="flex flex-col gap-1">
              {invalid.agent.issues.map((issue, index) => (
                <li key={index} className="text-xs leading-[1.5] text-[var(--sf-text-2)]">
                  <span className={`${MONO} text-[var(--sf-text-1)]`}>{issue.path || "file"}</span>
                  {issue.line ? ` (line ${issue.line})` : ""}: {issue.message}
                </li>
              ))}
            </ul>
            <p className="text-xs text-[var(--sf-text-3)]">Fix the file and this page updates on the next load.</p>
          </div>
        ) : copy ? (
          <>
            <p className="text-[13px] text-[var(--sf-text-2)]" data-testid="agent-missing">
              {copy.body}
            </p>
            <Button onClick={onBack ?? (() => navigate(agentsPath()))}>{copy.back}</Button>
          </>
        ) : error ? (
          <p className="text-[13px] text-[var(--sf-fail)]">{error.message}</p>
        ) : (
          <p className="text-[13px] text-[var(--sf-text-3)]">Loading…</p>
        )}
      </div>
    </div>
  );
}
