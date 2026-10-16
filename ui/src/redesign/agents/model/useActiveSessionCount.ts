import { useEffect, useState } from "react";
import { agentsApi } from "../../../api/agents";

const POLL_MS = 10_000;

/** Running or waiting agent sessions, for the sidebar badge. Stays 0 when the agents API is unavailable. */
export function useActiveSessionCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      agentsApi
        .allSessions({ limit: 1 })
        .then((page) => live && setCount(page.stats.active))
        .catch(() => live && setCount(0));
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  return count;
}
