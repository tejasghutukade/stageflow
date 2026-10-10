import type { TriggerAdapterStatus, TriggerListItem } from "../../api";

export function adapterStatusLabel(
  trigger: TriggerListItem,
  status?: TriggerAdapterStatus,
): string {
  if (!status) {
    if (trigger.kind === "schedule") return "Scheduled";
    if (trigger.kind === "manual") return "—";
    return "—";
  }
  const adapter = status.adapter.toLowerCase();
  if (adapter.includes("github")) {
    if (status.state === "polling" || status.state === "active") return "Polling";
    return status.state;
  }
  if (adapter.includes("email")) {
    if (status.state === "connected" || status.state === "watching") {
      return status.state === "connected" ? "Connected" : "Watching";
    }
    return status.state;
  }
  if (adapter.includes("webhook")) return "Endpoint ready";
  return status.state;
}
