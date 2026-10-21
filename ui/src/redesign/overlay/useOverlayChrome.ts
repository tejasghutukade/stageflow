import { useEffect } from "react";

export function useOverlayChrome(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.setAttribute("data-sf-overlay", "");
    const prevBody = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      root.removeAttribute("data-sf-overlay");
      document.body.style.overflow = prevBody;
    };
  }, [active]);
}
