import type { TriggerListItem } from "../../api";

export type TriggerFilterTab =
  | "all"
  | "schedule"
  | "event"
  | "manual"
  | "disabled"
  | "needs_attention";

export function filterTriggersByTab(
  triggers: TriggerListItem[],
  tab: TriggerFilterTab,
): TriggerListItem[] {
  if (tab === "all") return triggers;
  if (tab === "disabled") return triggers.filter((t) => !t.enabled);
  if (tab === "needs_attention") {
    return triggers.filter(
      (t) =>
        (t.kind === "schedule" && !t.task) ||
        t.adapter_status?.state === "error",
    );
  }
  return triggers.filter((t) => t.enabled && t.kind === tab);
}

export function groupTriggersByKind(
  triggers: TriggerListItem[],
): Array<{ kind: TriggerListItem["kind"]; items: TriggerListItem[] }> {
  const order: TriggerListItem["kind"][] = ["schedule", "event", "manual"];
  const groups = new Map<TriggerListItem["kind"], TriggerListItem[]>();
  for (const trigger of triggers) {
    const list = groups.get(trigger.kind) ?? [];
    list.push(trigger);
    groups.set(trigger.kind, list);
  }
  return order
    .filter((kind) => (groups.get(kind)?.length ?? 0) > 0)
    .map((kind) => ({
      kind,
      items: (groups.get(kind) ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export function scheduleWithoutCatalogTask(trigger: TriggerListItem): boolean {
  return trigger.kind === "schedule" && !trigger.task;
}
