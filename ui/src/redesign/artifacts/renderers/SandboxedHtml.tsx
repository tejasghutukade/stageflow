import { useMemo, useState, type ReactNode } from "react";
import { prepareStaticHtml } from "./htmlSandbox";

export function SandboxedHtml({ text, source }: { text: string; source: ReactNode }) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const srcDoc = useMemo(() => prepareStaticHtml(text), [text]);
  return (
    <div data-testid="artifact-html" className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--sf-text-2)]">
          Static preview: scripts and network access are disabled.
        </p>
        <div className="flex shrink-0 gap-1" data-testid="artifact-html-toggle" role="group" aria-label="HTML view">
          <button
            type="button"
            aria-pressed={mode === "rendered"}
            className="rounded-md border border-[var(--sf-hairline)] px-2 py-1 text-[12px] text-[var(--sf-text-2)]"
            onClick={() => setMode("rendered")}
          >
            Rendered
          </button>
          <button
            type="button"
            aria-pressed={mode === "source"}
            className="rounded-md border border-[var(--sf-hairline)] px-2 py-1 text-[12px] text-[var(--sf-text-2)]"
            onClick={() => setMode("source")}
          >
            Source
          </button>
        </div>
      </div>
      {mode === "source" ? (
        source
      ) : (
        <iframe
          title="Static HTML preview"
          sandbox=""
          srcDoc={srcDoc}
          data-testid="artifact-html-frame"
          className="h-full min-h-[480px] w-full flex-1 rounded-lg border border-[var(--sf-hairline)] bg-white"
        />
      )}
    </div>
  );
}
