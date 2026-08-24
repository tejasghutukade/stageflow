import { useEffect, useRef } from "react";
import type { RunSummary } from "./api";
import { useRunCatalog } from "./catalog/useRunCatalog";
import { waitingView } from "./catalog/views";

export type NotifyPreference = "system" | "off";

const KEY = "sf-notify-waiting";

export function readNotifyPreference(): NotifyPreference {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "system" || raw === "off") return raw;
  } catch {
    /* empty */
  }
  return "off";
}

export function writeNotifyPreference(value: NotifyPreference): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* empty */
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export function diffWaitingAppearances(
  waiting: RunSummary[],
  seen: Set<string> | null,
): { emit: RunSummary[]; nextSeen: Set<string> } {
  const waitingIds = new Set(waiting.map((run) => run.run_id));
  if (seen === null) {
    return { emit: [], nextSeen: waitingIds };
  }
  const emit: RunSummary[] = [];
  const nextSeen = new Set(seen);
  for (const run of waiting) {
    if (nextSeen.has(run.run_id)) continue;
    emit.push(run);
    nextSeen.add(run.run_id);
  }
  for (const id of [...nextSeen]) {
    if (!waitingIds.has(id)) nextSeen.delete(id);
  }
  return { emit, nextSeen };
}

export function useWaitingNotifications(enabled: boolean): void {
  const { snapshot, loading } = useRunCatalog();
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (loading) return;
    const waiting = waitingView(snapshot);
    const { emit, nextSeen } = diffWaitingAppearances(waiting, seenRef.current);
    seenRef.current = nextSeen;
    if (!enabled) return;
    for (const run of emit) {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const parts = [run.pipeline_id, run.waiting_summary].filter(
          (part): part is string => Boolean(part),
        );
        new Notification("Stage waiting on you", {
          body: parts.join(" — "),
        });
      }
    }
  }, [snapshot, loading, enabled]);
}
