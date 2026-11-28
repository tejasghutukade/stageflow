/**
 * Stageflow tools an anonymous visitor on a public chat link never gets, even with `web_chat.public_tools`: they run code
 * or processes on the owner's machine, change the Host's setup or secrets, or reach other agents and other people's
 * conversations. They keep working in the console and on signed-in (`access: authenticated`) links.
 * Pure data so the console can show the same list.
 */
export const PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS: ReadonlySet<string> = new Set([
  // Run code or processes on the owner's machine.
  "write_pipeline",
  "write_stage",
  "write_task",
  "import_task",
  "save_function",
  "test_function",
  "probe_project_mcp",
  "run_eval",
  "try_eval_case",
  "calibrate_eval_grader",
  // Change the Host's setup or secrets.
  "save_agent",
  "set_agent_enabled",
  "archive_agent",
  "save_connection",
  "test_connection",
  "remove_connection",
  "save_trigger",
  "delete_function",
  "save_eval",
  "save_dataset",
  "review_eval_results",
  "delete_eval_run",
  "cancel_eval_run",
  "delete_runs",
  "cancel_run",
  "abandon_stage",
  // Reach other agents or other people's conversations.
  "agent_chat",
  "stop_agent_session",
  "get_agent_session",
]);
