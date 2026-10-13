import type { CapacityHealth } from "../../api";

export type CapacitySlotKind = "running" | "held" | "free";

export function capacitySlotKinds(
  health: CapacityHealth,
  heldWaitingCount: number,
): CapacitySlotKind[] {
  const max = Math.max(0, health.maxConcurrent);
  const active = Math.min(max, Math.max(0, health.activeCount));
  const held = Math.min(active, Math.max(0, heldWaitingCount));
  const running = Math.max(0, active - held);
  const free = Math.max(0, max - active);
  const kinds: CapacitySlotKind[] = [];
  for (let i = 0; i < running; i++) kinds.push("running");
  for (let i = 0; i < held; i++) kinds.push("held");
  for (let i = 0; i < free; i++) kinds.push("free");
  return kinds;
}

export function capacitySlotClass(kind: CapacitySlotKind): string {
  if (kind === "running") return "bg-[var(--sf-running)]";
  if (kind === "held") return "bg-[var(--sf-needs)]";
  return "bg-[var(--sf-track-empty)]";
}

export function capacityHintLine(heldWaitingCount: number): string | null {
  if (heldWaitingCount <= 0) return null;
  if (heldWaitingCount === 1) {
    return "1 slot held by a run waiting on you";
  }
  return `${heldWaitingCount} slots held by runs waiting on you`;
}
