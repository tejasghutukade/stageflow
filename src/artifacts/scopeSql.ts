export function artifactScopePredicate(scope: "project" | "session" | undefined): string {
  if (scope === "session") return "a.scope = 'session'";
  return "(a.scope IS NULL OR a.scope = 'project')";
}

export const EVAL_SESSION_ARTIFACT_EXCLUSION =
  "NOT EXISTS (SELECT 1 FROM agent_sessions es WHERE es.session_id = a.source_session_id AND es.source = 'eval')";
