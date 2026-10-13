import type { TriggerListItem } from "../../api";
import { adapterStatusLabel } from "./triggerAdapterLabel";
import { triggerScheduleSummary } from "../../pages/TriggersPage";

export function triggerRowSummary(trigger: TriggerListItem): string {
  if (trigger.kind === "event" && trigger.event) {
    return trigger.event.source;
  }
  if (trigger.kind === "schedule" && trigger.schedule) {
    return trigger.schedule.timezone
      ? `${trigger.schedule.cron} · ${trigger.schedule.timezone}`
      : trigger.schedule.cron;
  }
  return "Fired manually only";
}

export function triggerNextCell(trigger: TriggerListItem): {
  dot?: "ok" | "muted";
  label: string;
} {
  if (!trigger.enabled) {
    return { label: "disabled" };
  }
  if (trigger.kind === "schedule" && trigger.next_run_at) {
    return { dot: "ok", label: trigger.next_run_at.slice(11, 16) };
  }
  if (trigger.kind === "event") {
    const adapter = adapterStatusLabel(trigger, trigger.adapter_status);
    if (adapter === "Polling") return { dot: "ok", label: "polling" };
    return { label: adapter === "—" ? "—" : adapter.toLowerCase() };
  }
  if (trigger.kind === "manual") {
    return { label: "—" };
  }
  return { label: "—" };
}

export function triggerMatchesQuery(
  trigger: TriggerListItem,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    trigger.id,
    trigger.pipeline,
    trigger.task ?? "",
    triggerScheduleSummary(trigger),
    trigger.event?.source ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function triggerNeedsAttention(trigger: TriggerListItem): boolean {
  if (trigger.kind === "schedule" && !trigger.task) return true;
  if (trigger.adapter_status?.state === "error") return true;
  return false;
}
