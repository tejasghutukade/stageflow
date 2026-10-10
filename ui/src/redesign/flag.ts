import { useEffect, useState } from "react";

const KEY = "sf-ui-redesign";
export const REDESIGN_STORAGE_EVENT = "sf-ui-redesign";

export function readRedesignPreference(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function applyRedesignAttribute(enabled: boolean): void {
  if (enabled) {
    document.documentElement.setAttribute("data-redesign", "on");
  } else {
    document.documentElement.removeAttribute("data-redesign");
  }
}

export function writeRedesignPreference(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    /* empty */
  }
  applyRedesignAttribute(on);
  window.dispatchEvent(new Event(REDESIGN_STORAGE_EVENT));
}

export function useRedesign(): boolean {
  const [enabled, setEnabled] = useState(readRedesignPreference);

  useEffect(() => {
    applyRedesignAttribute(enabled);
  }, [enabled]);

  useEffect(() => {
    const sync = () => setEnabled(readRedesignPreference());
    window.addEventListener("storage", sync);
    window.addEventListener(REDESIGN_STORAGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(REDESIGN_STORAGE_EVENT, sync);
    };
  }, []);

  return enabled;
}
