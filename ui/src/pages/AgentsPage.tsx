import { AgentsRedesign, type AgentsScreen } from "../redesign/agents/AgentsRedesign";

export function AgentsPage({
  agentId,
  sessionId,
  runId,
  screen = "directory",
}: {
  agentId?: string;
  sessionId?: string;
  runId?: string;
  screen?: AgentsScreen;
}) {
  const resolved: AgentsScreen = screen === "create" ? "create" : agentId ? screen : "directory";
  return <AgentsRedesign agentId={agentId} sessionId={sessionId} runId={runId} screen={resolved} />;
}
