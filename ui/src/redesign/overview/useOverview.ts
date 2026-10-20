import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchChannelConnections,
  fetchConnections,
  fetchOverview,
  fetchTriggers,
  type ChannelConnectionListing,
  type ConnectionListing,
  type OverviewRange,
  type OverviewSummary,
  type TriggerListItem,
} from "../../api";
import { agentsApi, type AgentSessionListItem, type SessionStats } from "../../api/agents";

const POLL_MS = 15_000;

export type OverviewData = {
  overview: OverviewSummary | null;
  overviewFailed: boolean;
  triggers: TriggerListItem[];
  channels: ChannelConnectionListing[];
  email: ConnectionListing[];
  sessions: AgentSessionListItem[];
  sessionStats: SessionStats | null;
  agentNames: Map<string, string>;
  loaded: boolean;
  refresh: () => void;
};

/**
 * Everything on the Overview that the run catalog does not already poll. Each source loads on its
 * own, so one failing API leaves the rest of the page standing.
 */
export function useOverview(range: OverviewRange): OverviewData {
  const [overview, setOverview] = useState<OverviewSummary | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [triggers, setTriggers] = useState<TriggerListItem[]>([]);
  const [channels, setChannels] = useState<ChannelConnectionListing[]>([]);
  const [email, setEmail] = useState<ConnectionListing[]>([]);
  const [sessions, setSessions] = useState<AgentSessionListItem[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [agentNames, setAgentNames] = useState<Map<string, string>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const live = useRef(true);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    const requested = rangeRef.current;
    const [ov, trig, chan, mail, sess, agents] = await Promise.allSettled([
      fetchOverview(requested),
      fetchTriggers(),
      fetchChannelConnections(),
      fetchConnections(),
      agentsApi.allSessions({ limit: 20 }),
      agentsApi.list(),
    ]);
    if (!live.current) return;
    if (ov.status === "fulfilled" && rangeRef.current === requested) {
      setOverview(ov.value);
      setOverviewFailed(false);
    } else if (ov.status === "rejected") {
      setOverviewFailed(true);
    }
    if (trig.status === "fulfilled") setTriggers(trig.value.triggers);
    if (chan.status === "fulfilled") setChannels(chan.value.connections);
    if (mail.status === "fulfilled") setEmail(mail.value);
    if (sess.status === "fulfilled") {
      setSessions(sess.value.sessions);
      setSessionStats(sess.value.stats);
    }
    if (agents.status === "fulfilled") setAgentNames(new Map(agents.value.map((agent) => [agent.id, agent.name])));
    setLoaded(true);
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
  }, [load, range]);

  return { overview, overviewFailed, triggers, channels, email, sessions, sessionStats, agentNames, loaded, refresh: () => void load() };
}
