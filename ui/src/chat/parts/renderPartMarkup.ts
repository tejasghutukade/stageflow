import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export function renderPartMarkup(node: ReactNode): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const html = container.innerHTML;
  act(() => {
    root.unmount();
  });
  return html;
}