import type { ReactNode } from "react";

export type UiPartRendererContext = {
  onOpenConsole?: (href: string) => void;
};

export type UiPartRendererProps = {
  part: unknown;
  context: UiPartRendererContext;
};

export type UiPartRenderer = (props: UiPartRendererProps) => ReactNode;

const renderers = new Map<string, UiPartRenderer>();

export function registerUiPart(kind: string, renderer: UiPartRenderer): void {
  renderers.set(kind, renderer);
}

export function lookupUiPart(kind: string): UiPartRenderer {
  return renderers.get(kind) ?? unknownUiPartRenderer;
}

function unknownUiPartRenderer({ part, context }: UiPartRendererProps): ReactNode {
  const record = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : null;
  const title = typeof record?.title === "string" ? record.title : "Interactive content";
  const fallbackUrl =
    typeof record?.fallback === "object" && record?.fallback !== null
      ? (record.fallback as { url?: unknown }).url
      : undefined;
  const href = typeof fallbackUrl === "string" ? fallbackUrl : undefined;
  return (
    <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
      <p className="m-0 font-medium">{title}</p>
      <p className="mt-1 mb-0 text-[var(--sf-text-2)]">This message includes content the console cannot render here.</p>
      {href ? (
        <button
          type="button"
          className="mt-2 text-[13px] underline decoration-[var(--sf-hairline)]"
          onClick={() =>
            context.onOpenConsole
              ? context.onOpenConsole(href)
              : window.open(href, "_blank", "noopener,noreferrer")
          }
        >
          Open in console
        </button>
      ) : (
        <p className="mt-2 mb-0 text-[12px] text-[var(--sf-text-3)]">Open this thread in the operator console to view it.</p>
      )}
    </div>
  );
}

export function renderUiPart(part: unknown, context: UiPartRendererContext = {}): ReactNode {
  const record = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : null;
  const kind = typeof record?.kind === "string" ? record.kind : "";
  return lookupUiPart(kind)({ part, context });
}