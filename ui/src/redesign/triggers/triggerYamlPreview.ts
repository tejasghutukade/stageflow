import type { TriggerKind, TaskMode } from "../../components/NewTriggerPanel";

export function buildTriggerYamlPreview(values: {
  id: string;
  pipeline: string;
  taskMode: TaskMode;
  task: string;
  kind: TriggerKind;
  cron: string;
  timezone: string;
  source: string;
  enabled: boolean;
}): string {
  const lines: string[] = ["id: " + (values.id.trim() || "my-trigger")];
  lines.push("pipeline: " + (values.pipeline || "pipeline-id"));
  if (values.taskMode === "catalog" && values.task) {
    lines.push("task: " + values.task);
  }
  lines.push("kind: " + values.kind);
  if (values.kind === "schedule") {
    lines.push("schedule:");
    lines.push("  cron: " + JSON.stringify(values.cron.trim() || "0 * * * *"));
    if (values.timezone.trim()) {
      lines.push("  timezone: " + JSON.stringify(values.timezone.trim()));
    }
  }
  if (values.kind === "event") {
    lines.push("event:");
    lines.push("  source: " + JSON.stringify(values.source.trim() || "github"));
  }
  lines.push("enabled: " + (values.enabled ? "true" : "false"));
  return lines.join("\n") + "\n";
}
