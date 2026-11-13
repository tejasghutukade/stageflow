import { useEffect, useRef, useState } from "react";
import { MONO } from "../agents/agentsTokens";

const FRAME = "overflow-hidden rounded-lg border bg-[var(--sf-panel)] focus-within:border-[var(--sf-text-3)]";

const FALLBACK =
  "min-h-72 w-full resize-y bg-transparent px-3 py-2.5 text-xs leading-[1.65] text-[var(--sf-text-1)] outline-none";

export function FunctionSourceEditor({
  value,
  onChange,
  invalid = false,
}: {
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const editorRef = useRef<{ destroy: () => void; setValue: (next: string) => void } | undefined>(undefined);
  const [plain, setPlain] = useState(false);
  const [ready, setReady] = useState(false);
  onChangeRef.current = onChange;
  valueRef.current = value;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let dead = false;
    void import("./mountJavaScriptEditor")
      .then((mod) => {
        if (dead || !host.current) return;
        editorRef.current = mod.mountJavaScriptEditor(host.current, valueRef.current, (next) => onChangeRef.current(next));
        setReady(true);
      })
      .catch(() => {
        if (!dead) setPlain(true);
      });
    return () => {
      dead = true;
      editorRef.current?.destroy();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.setValue(value);
  }, [value]);

  const border = invalid ? "border-[#f2645a80]" : "border-[var(--sf-hairline-strong)]";

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label="Function source"
        readOnly={!plain}
        value={value}
        spellCheck={false}
        onChange={plain ? (event) => onChange(event.target.value) : undefined}
        className={plain ? `${MONO} ${FRAME} ${border} ${FALLBACK}` : "sr-only"}
      />
      {plain ? (
        <p className="text-xs text-[var(--sf-text-3)]">Syntax highlighting did not load. You can still edit the source here.</p>
      ) : (
        <div ref={host} data-testid="function-source" className={`${FRAME} ${border} ${ready ? "" : "min-h-72"}`}>
          {ready ? null : <p className="px-3 py-2.5 text-xs text-[var(--sf-text-3)]">Loading editor…</p>}
        </div>
      )}
    </div>
  );
}
