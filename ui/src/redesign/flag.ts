import { useEffect } from "react";

/** New console styles are scoped to this attribute. It is always on. */
export function applyRedesignAttribute(): void {
  document.documentElement.setAttribute("data-redesign", "on");
}

export function useRedesign(): boolean {
  useEffect(() => {
    applyRedesignAttribute();
  }, []);
  return true;
}
