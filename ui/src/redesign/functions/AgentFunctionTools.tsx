import { useEffect, useRef, useState } from "react";
import { functionsApi, type FunctionDefinition, type FunctionSummary } from "../../api/functions";
import { functionNewPath } from "../../routes";
import { describeAccess } from "./functionAccess";
import { AccessConfirm, AddSelect, AttachedRow, FindingList, requestAccessPrompt, useResolvedDefinitions, type PendingAccess } from "./FunctionAttachmentParts";
import { grantsForCapabilities, placeFunction, staleGrants, type FunctionAttachmentDraft } from "./functionAttachments";

export function AgentFunctionTools({
  attachments,
  onChange,
  catalog: catalogProp,
  definitions,
  initialPending,
}: {
  attachments: readonly FunctionAttachmentDraft[];
  onChange?: (next: FunctionAttachmentDraft[]) => void;
  catalog?: FunctionSummary[];
  definitions?: Readonly<Record<string, FunctionDefinition | null>>;
  initialPending?: PendingAccess | null;
}) {
  const provided = catalogProp !== undefined;
  const [catalog, setCatalog] = useState<FunctionSummary[]>(catalogProp ?? []);
  const [known, setKnown] = useState(provided);
  const [finding, setFinding] = useState<{ message: string; href: string } | null>(null);
  const [pending, setPending] = useState<PendingAccess | null>(initialPending ?? null);
  const attachmentsRef = useRef(attachments);
  const pendingRef = useRef(pending);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  attachmentsRef.current = attachments;
  pendingRef.current = pending;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (provided) return;
    let live = true;
    void functionsApi.list().then(
      (rows) => {
        if (!live) return;
        setCatalog(rows);
        setKnown(true);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [provided]);

  const targets = attachments.flatMap((attachment) => {
    const fn = catalog.find((row) => row.id === attachment.id);
    return fn ? [{ id: attachment.id, revision: fn.revision }] : [];
  });
  const resolved = useResolvedDefinitions(targets, definitions);
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
      const prompt = await requestAccessPrompt(id, fn.name?.trim() || id);
      if (!mounted.current || !prompt.ok) return;
      if ("immediate" in prompt) {
        if (attachmentsRef.current.some((item) => item.id === id)) return;
        onChange([...attachmentsRef.current, prompt.immediate]);
        return;
      }
      setPending({ ...prompt.confirm, mode: "add" });
    } finally {
      inFlight.current.delete(id);
    }
  }

  function allow() {
    const prompt = pendingRef.current;
    if (!prompt || !onChange) return;
    const current = attachmentsRef.current;
    if (prompt.mode === "replace") {
      if (!current.some((item) => item.id === prompt.id)) {
        setPending(null);
        return;
      }
      onChange(current.map((item) => (item.id === prompt.id ? { id: item.id, grants: prompt.grants } : item)));
    } else if (!current.some((item) => item.id === prompt.id)) {
      onChange([...current, { id: prompt.id, grants: prompt.grants }]);
    }
    setPending(null);
  }

  function review(attachment: FunctionAttachmentDraft) {
    const definition = resolved[attachment.id];
    if (!definition) return;
    const fn = catalog.find((row) => row.id === attachment.id);
    setPending({
      id: attachment.id,
      name: fn?.name?.trim() || attachment.id,
      labels: describeAccess(definition.capabilities),
      grants: grantsForCapabilities(definition.capabilities),
      mode: "replace",
    });
  }

  const options = tools.filter((row) => !attachments.some((item) => item.id === row.id));
  const findings = [...mismatches, ...(finding ? [finding] : [])].filter(
    (item, index, all) => all.findIndex((other) => other.href === item.href && other.message === item.message) === index,
  );

  return (
    <div className="flex flex-col gap-2" data-testid="agent-function-tools">
      <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Functions</span>
      <p className="text-xs leading-normal text-[var(--sf-text-3)]">
        Tool functions this agent can call. Each runs sealed, with only the grants listed beside it.
      </p>
      {attachments.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {attachments.map((attachment) => {
            const definition = resolved[attachment.id];
            const stale = definition ? staleGrants(attachment, definition) : false;
            return (
              <AttachedRow
                key={attachment.id}
                attachment={attachment}
                fn={catalog.find((row) => row.id === attachment.id)}
                known={known}
                stale={stale}
                onReview={stale ? () => review(attachment) : undefined}
                onRemove={onChange ? () => onChange(attachmentsRef.current.filter((item) => item.id !== attachment.id)) : undefined}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3.5 py-3 text-xs text-[var(--sf-text-3)]">
          {known && tools.length === 0 ? (
            <>
              No tool functions in this project yet.{" "}
              <a href={`#${functionNewPath("tool")}`} className="text-[var(--sf-text-2)] underline">
                Create one
              </a>
            </>
          ) : (
            "No functions attached."
          )}
        </div>
      )}
      {pending ? <AccessConfirm name={pending.name} labels={pending.labels} onAllow={allow} onCancel={() => setPending(null)} /> : null}
      {onChange ? <AddSelect label="Agent function" prompt="Add a tool function…" emptyLabel={attachments.length > 0 ? "All tool functions added" : "No tool functions yet"} options={options} onAdd={(id) => void add(id)} /> : null}
      <FindingList findings={findings} />
    </div>
  );
}
