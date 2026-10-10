import type { TriggerEvent, TriggerSchedule } from "../../api";

export type TriggerYamlPreviewInput = {
  id: string;
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  enabled: boolean;
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
};

const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

export function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  if (typeof value !== "string") return JSON.stringify(value);
  if (PLAIN_SCALAR.test(value) && !RESERVED.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

function pushRecord(lines: string[], record: Record<string, unknown>, indent: string): void {
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`);
      pushRecord(lines, value as Record<string, unknown>, indent + "  ");
    } else {
      lines.push(`${indent}${key}: ${yamlScalar(value)}`);
    }
  }
}

export function buildTriggerYamlPreview(values: TriggerYamlPreviewInput): string {
  const lines: string[] = [`id: ${yamlScalar(values.id.trim() || "my-trigger")}`];
  lines.push(`pipeline: ${yamlScalar(values.pipeline || "pipeline-id")}`);
  if (values.task) lines.push(`task: ${yamlScalar(values.task)}`);
  lines.push(`kind: ${values.kind}`);
  lines.push(`enabled: ${values.enabled ? "true" : "false"}`);
  if (values.kind === "schedule" && values.schedule) {
    lines.push("schedule:");
    pushRecord(lines, values.schedule, "  ");
  }
  if (values.kind === "event" && values.event) {
    lines.push("event:");
    pushRecord(lines, values.event, "  ");
  }
  return lines.join("\n") + "\n";
}
