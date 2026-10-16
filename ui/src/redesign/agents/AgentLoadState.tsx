import { LuTriangleAlert } from "react-icons/lu";
import { AgentApiError, type AgentDetail } from "../../api/agents";
import { agentsPath, navigate } from "../../routes";
import { MONO, PAGE_BG } from "./agentsTokens";
import { Button, PageHeader } from "./ui";

/** Shell for an agent page that has nothing to show yet: loading, missing, failed, or a file that doesn't parse. */
export function AgentLoadError({
  loading,
  error,
  invalid,
}: {
  loading: boolean;
  error: Error | null;
  invalid?: AgentDetail;
}) {
  const missing = error instanceof AgentApiError && error.status === 404;
  return (
    <div className={PAGE_BG}>
      <PageHeader
        roomy
        crumbs={[{ label: "Agents", onClick: () => navigate(agentsPath()) }, ...(invalid ? [{ label: invalid.agent.id }] : [])]}
        title={invalid ? invalid.agent.id : missing ? "Agent not found" : loading ? "Loading…" : "Agent"}
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
        ) : missing ? (
          <>
            <p className="text-[13px] text-[var(--sf-text-2)]" data-testid="agent-missing">
              This agent is not in the project.
            </p>
            <Button onClick={() => navigate(agentsPath())}>All agents</Button>
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
