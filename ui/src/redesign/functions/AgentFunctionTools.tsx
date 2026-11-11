import { useEffect, useRef, useState } from "react";
import { functionsApi, type FunctionGrant, type FunctionSummary } from "../../api/functions";
import { functionPath } from "../../routes";
import { grantsForCapabilities, placeFunction, type FunctionAttachmentDraft } from "./functionAttachments";

export function AgentFunctionTools({
  attachments,
  onChange,
}: {
  attachments: readonly FunctionAttachmentDraft[];
  onChange?: (next: FunctionAttachmentDraft[]) => void;
}) {
  const [catalog, setCatalog] = useState<FunctionSummary[]>([]);
  const [choice, setChoice] = useState("");
  const [finding, setFinding] = useState<{ message: string; href: string } | null>(null);
  const attachmentsRef = useRef(attachments);
  const inFlight = useRef(new Set<string>());
  attachmentsRef.current = attachments;

  useEffect(() => {
    let live = true;
    void functionsApi.list().then(
      (rows) => {
        if (live) setCatalog(rows);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const tools = catalog.filter((row) => row.kind === "tool");
  const mismatches = attachments.flatMap((attachment) => {
    const fn = catalog.find((row) => row.id === attachment.id);
    if (!fn?.kind) return [];
    const placed = placeFunction("tool", { id: fn.id, kind: fn.kind });
    return placed.ok ? [] : [placed];
  });

  async function add(id: string) {
    const fn = catalog.find((row) => row.id === id);
    if (!fn?.kind || !onChange) return;
    if (inFlight.current.has(id) || attachmentsRef.current.some((item) => item.id === id)) return;
    const placed = placeFunction("tool", { id: fn.id, kind: fn.kind });
    if (!placed.ok) {
      setFinding(placed);
      return;
    }
    setFinding(null);
    inFlight.current.add(id);
    try {
      let grants: FunctionGrant[] = [];
      try {
        const detail = await functionsApi.get(id);
        if (detail.definition) grants = grantsForCapabilities(detail.definition.capabilities);
      } catch {
        grants = [];
      }
      if (attachmentsRef.current.some((item) => item.id === id)) return;
      onChange([...attachmentsRef.current, { id, grants }]);
    } finally {
      inFlight.current.delete(id);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="agent-function-tools">
      <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Functions</span>
      <p className="text-xs leading-normal text-[var(--sf-text-3)]">
        tools.functions entries are an id plus grants. Only a tool can be attached here.
      </p>
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex items-center justify-between gap-2 text-xs text-[var(--sf-text-1)]">
          <a href={`#${functionPath(attachment.id)}`} className="underline">
            {attachment.id}
            {attachment.grants.length > 0 ? ` (${attachment.grants.map((grant) => grant.id).join(", ")})` : ""}
          </a>
          {onChange ? (
            <button type="button" className="text-[var(--sf-text-3)]" onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {onChange ? (
        <div className="flex gap-2">
          <select aria-label="Agent function" value={choice} onChange={(event) => setChoice(event.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 text-[13px] text-[var(--sf-text-1)]">
            <option value="">Choose a tool</option>
            {tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name || tool.id}
              </option>
            ))}
          </select>
          <button type="button" className="rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 text-xs text-[var(--sf-text-1)]" onClick={() => choice && void add(choice)}>
            Add
          </button>
        </div>
      ) : null}
      {[...mismatches, ...(finding ? [finding] : [])].map((item) => (
        <p key={item.href} role="alert" className="text-xs text-[var(--sf-fail)]">
          {item.message}{" "}
          <a href={`#${item.href}`} className="underline">
            Open definition
          </a>
        </p>
      ))}
    </div>
  );
}
