import { useCallback, useEffect, useRef, useState } from "react";
import { agentsApi } from "../../../api/agents";
import type { AgentApprovalItem } from "../../inbox/needsQueue";

const POLL_MS = 5000;

/** Agent approvals waiting on an operator, with agent names, kept fresh while the tab is visible. */
export function useAgentApprovals(): { approvals: AgentApprovalItem[]; refresh: () => void } {
  const [approvals, setApprovals] = useState<AgentApprovalItem[]>([]);
  const names = useRef(new Map<string, string>());
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const pending = await agentsApi.pendingApprovals();
      if (pending.some((item) => !names.current.has(item.agentId))) {
        const agents = await agentsApi.list().catch(() => []);
        for (const agent of agents) names.current.set(agent.id, agent.name);
      }
      if (live.current) {
        setApprovals(pending.map((item) => ({ ...item, ...(names.current.has(item.agentId) ? { agentName: names.current.get(item.agentId)! } : {}) })));
      }
    } catch {
      // Keep what is on screen; the next poll retries.
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => {
      live.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  return { approvals, refresh: () => void load() };
}
