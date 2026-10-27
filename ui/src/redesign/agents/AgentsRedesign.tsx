import { agentCreatePath, navigate } from "../../routes";
import { AgentsDirectoryPage } from "./AgentsDirectoryPage";
import { agentCreateRemountKey } from "./create/agentCreateRemountKey";
import { AgentCreatePage } from "./create/AgentCreatePage";
import { AgentDetailPage } from "./detail/AgentDetailPage";
import { AgentEditPage } from "./edit/AgentEditPage";
import { AgentRunPage } from "./run/AgentRunPage";
import { AgentSessionPage } from "./session/AgentSessionPage";

export type AgentsScreen = "directory" | "create" | "detail" | "edit" | "session" | "run";

export function AgentsRedesign({
  agentId,
  sessionId,
  runId,
  authorSessionId,
  screen,
}: {
  agentId?: string;
  sessionId?: string;
  runId?: string;
  authorSessionId?: string;
  screen: AgentsScreen;
}) {
  if (screen === "create") {
    return <AgentCreatePage key={agentCreateRemountKey(authorSessionId)} authorSessionId={authorSessionId} />;
  }
  if (!agentId || screen === "directory") {
    return <AgentsDirectoryPage onNewAgent={() => navigate(agentCreatePath())} />;
  }
  if (screen === "edit") return <AgentEditPage key={agentId} agentId={agentId} />;
  if (screen === "session" && sessionId) {
    return <AgentSessionPage key={`${agentId}:${sessionId}`} agentId={agentId} sessionId={sessionId} />;
  }
  if (screen === "run" && sessionId && runId) {
    return <AgentRunPage key={`${agentId}:${sessionId}:${runId}`} agentId={agentId} sessionId={sessionId} runId={runId} />;
  }
  return <AgentDetailPage key={agentId} agentId={agentId} />;
}
