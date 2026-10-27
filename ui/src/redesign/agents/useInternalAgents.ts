import { useEffect, useState } from "react";
import { fetchInternalAgents, HIDDEN_INTERNAL_AGENTS, type InternalAgentsResponse } from "../../api/internalAgents";

/** `GET /api/internal-agents`; hidden until the Host says otherwise. */
export function useInternalAgents(): InternalAgentsResponse {
  const [state, setState] = useState<InternalAgentsResponse>(HIDDEN_INTERNAL_AGENTS);
  useEffect(() => {
    let live = true;
    void fetchInternalAgents().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
