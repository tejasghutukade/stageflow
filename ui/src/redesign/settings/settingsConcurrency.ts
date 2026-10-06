import type { CapacityHealth } from "../../api";

export type SlotDisplayState = "running" | "held" | "free" | "disabled";

export function computeConcurrencySlots(
  health: CapacityHealth | null | undefined,
  held: number,
): {
  maxSlots: number;
  running: number;
  held: number;
  free: number;
  slotStates: SlotDisplayState[];
} {
  const maxSlots = health?.maxConcurrent ?? 0;
  const free = health?.slotsAvailable ?? 0;
  const occupying =
    maxSlots > 0 ? Math.max(0, maxSlots - free) : health?.activeCount ?? 0;
  const heldCount = Math.max(0, held);
  const running = Math.max(0, occupying - heldCount);

  const slotStates: SlotDisplayState[] = [];
  for (let i = 0; i < 6; i++) {
    if (maxSlots <= 0 || i >= maxSlots) {
      slotStates.push("disabled");
      continue;
    }
    if (i < running) slotStates.push("running");
    else if (i < running + heldCount) slotStates.push("held");
    else slotStates.push("free");
  }

  return {
    maxSlots,
    running,
    held: heldCount,
    free,
    slotStates,
  };
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
