import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api/client";

export type HostInfo = {
  hosted: boolean;
  managed: boolean;
  publicUrl: string | null;
  publicChatUrl: string | null;
};

const EMPTY: HostInfo = { hosted: false, managed: false, publicUrl: null, publicChatUrl: null };

let current: HostInfo = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: HostInfo): void {
  current = next;
  for (const listener of listeners) listener();
}

function load(): void {
  if (loading) return;
  loading = api<HostInfo>("/api/host-info")
    .then((info) => publish({ ...EMPTY, ...info }))
    .catch(() => {
      loading = null;
    });
}

export function getHostInfo(): HostInfo {
  return current;
}

export function setHostInfoForTests(info: HostInfo | null): void {
  loading = info ? Promise.resolve() : null;
  publish(info ?? EMPTY);
}

/** What the Host says its public addresses are. Until it answers, the browser's own address is what the console shows. */
export function useHostInfo(): HostInfo {
  useEffect(load, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getHostInfo,
    getHostInfo,
  );
}

/** Origin for the console, API and MCP. */
export function consoleOrigin(info: HostInfo, browserOrigin: string): string {
  return info.publicUrl ?? browserOrigin;
}

/** Origin for public web chat pages and their sign-in callbacks. */
export function chatOrigin(info: HostInfo, browserOrigin: string): string {
  return info.publicChatUrl ?? info.publicUrl ?? browserOrigin;
}
