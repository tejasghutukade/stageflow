import { useEffect, useRef, useState } from "react";

const FIELD =
  "min-h-56 w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2.5 py-2 font-mono text-[13px] text-[var(--sf-text-1)] outline-none";

export function FunctionSourceEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const editorRef = useRef<{ destroy: () => void; setValue: (next: string) => void } | undefined>(undefined);
  const [plain, setPlain] = useState(false);
  onChangeRef.current = onChange;
  valueRef.current = value;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let dead = false;
    void import("./mountJavaScriptEditor")
      .then((mod) => {
        if (dead || !host.current) return;
        const editor = mod.mountJavaScriptEditor(host.current, valueRef.current, (next) => onChangeRef.current(next));
        editorRef.current = editor;
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

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label="Function source"
        readOnly={!plain}
        value={value}
        onChange={plain ? (event) => onChange(event.target.value) : undefined}
        className={plain ? FIELD : "sr-only"}
      />
      {plain ? (
        <p className="text-xs text-[var(--sf-text-3)]">Source highlighting did not load. You can still edit the source here.</p>
      ) : (
        <div
          ref={host}
          data-testid="function-source"
          className="min-h-56 overflow-hidden rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]"
        />
      )}
    </div>
  );
}
