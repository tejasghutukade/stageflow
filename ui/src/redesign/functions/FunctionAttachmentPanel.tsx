import { useEffect, useRef, useState, type DragEvent } from "react";
import { functionsApi, type FunctionGrant, type FunctionSummary } from "../../api/functions";
import type { DraftPackagePayload } from "../../api";
import { functionPath } from "../../routes";
import {
  grantsForCapabilities,
  placeFunction,
  readFunctionChecks,
  readRouteFunction,
  readStageFunctionTools,
  slotMismatches,
  writeFunctionChecks,
  writeRouteFunction,
  writeStageFunctionTools,
  type FunctionAttachmentDraft,
  type FunctionSlot,
} from "./functionAttachments";

const LABEL = "w-fit text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";

function addAttachment(
  current: readonly FunctionAttachmentDraft[],
  id: string,
  grants: FunctionGrant[],
): FunctionAttachmentDraft[] {
  if (current.some((item) => item.id === id)) return [...current];
  return [...current, { id, grants }];
}

export function FunctionAttachmentPanel({
  draft,
  stageId,
  catalog,
  onDraftChange,
}: {
  draft: DraftPackagePayload;
  stageId: string;
  catalog?: FunctionSummary[];
  onDraftChange: (draft: DraftPackagePayload) => void;
}) {
  const provided = catalog !== undefined;
  const [loaded, setLoaded] = useState<FunctionSummary[]>(catalog ?? []);
  const [rejected, setRejected] = useState<{ message: string; href: string } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const rows = provided ? catalog : loaded;

  useEffect(() => {
    if (provided) return;
    let live = true;
    void functionsApi.list().then(
      (list) => {
        if (live) setLoaded(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [provided]);

  const tools = readStageFunctionTools(draft, stageId);
  const checks = readFunctionChecks(draft, stageId);
  const route = readRouteFunction(draft, stageId);
  const findings = [
    ...slotMismatches("tool", tools, rows),
    ...slotMismatches("check", checks, rows),
    ...slotMismatches("route", route ? [route] : [], rows),
    ...(rejected ? [{ ok: false as const, message: rejected.message, href: rejected.href }] : []),
  ];
  const seen = new Set<string>();
  const uniqueFindings = findings.filter((finding) => {
    const key = `${finding.href}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  async function accept(slot: FunctionSlot, id: string) {
    const fn = rows.find((row) => row.id === id);
    if (!fn || !fn.kind) return;
    const placed = placeFunction(slot, { id: fn.id, kind: fn.kind });
    if (!placed.ok) {
      setRejected(placed);
      return;
    }
    setRejected(null);
    let grants: FunctionGrant[] = [];
    try {
      const detail = await functionsApi.get(id);
      if (detail.definition) grants = grantsForCapabilities(detail.definition.capabilities);
    } catch {
      grants = [];
    }
    const attachment = { id, grants };
    const current = draftRef.current;
    if (slot === "tool") {
      onDraftChange(writeStageFunctionTools(current, stageId, addAttachment(readStageFunctionTools(current, stageId), id, grants)));
    } else if (slot === "check") {
      onDraftChange(writeFunctionChecks(current, stageId, addAttachment(readFunctionChecks(current, stageId), id, grants)));
    } else onDraftChange(writeRouteFunction(current, stageId, attachment));
  }

  function onDrop(slot: FunctionSlot, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    if (id) accept(slot, id);
  }

  return (
    <div className="flex flex-col gap-3">
      <Slot
        label="Checks"
        hint="Stage body. A check is type function plus the function id."
        attachments={checks}
        options={rows.filter((row) => row.kind === "verification")}
        onAdd={(id) => void accept("check", id)}
        onRemove={(id) => onDraftChange(writeFunctionChecks(draft, stageId, checks.filter((item) => item.id !== id)))}
        onDrop={(event) => onDrop("check", event)}
      />
      <Slot
        label="Tools"
        hint="Stage body. tools.functions entries are an id plus grants."
        attachments={tools}
        options={rows.filter((row) => row.kind === "tool")}
        onAdd={(id) => void accept("tool", id)}
        onRemove={(id) => onDraftChange(writeStageFunctionTools(draft, stageId, tools.filter((item) => item.id !== id)))}
        onDrop={(event) => onDrop("tool", event)}
      />
      <Slot
        label="Route function"
        hint="Pipeline stage entry that owns route. if stays on each edge."
        attachments={route ? [route] : []}
        options={rows.filter((row) => row.kind === "routing")}
        single
        onAdd={(id) => void accept("route", id)}
        onRemove={() => onDraftChange(writeRouteFunction(draft, stageId, null))}
        onDrop={(event) => onDrop("route", event)}
      />
      {rows.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((row) => (
            <span
              key={row.id}
              draggable
              onDragStart={(event) => event.dataTransfer.setData("text/plain", row.id)}
              className="cursor-grab rounded-md border border-[#ffffff1a] px-1.5 py-0.5 text-[11px] text-[#a7aab2]"
            >
              {row.name || row.id}
            </span>
          ))}
        </div>
      ) : null}
      {uniqueFindings.map((finding) => (
        <p key={`${finding.href}-${finding.message}`} role="alert" data-testid="function-slot-finding" className="text-xs leading-[1.4] text-[#f0a0a0]">
          {finding.message}{" "}
          <a href={`#${finding.href}`} className="underline">
            Open definition
          </a>
        </p>
      ))}
    </div>
  );
}

function Slot({
  label,
  hint,
  attachments,
  options,
  single,
  onAdd,
  onRemove,
  onDrop,
}: {
  label: string;
  hint: string;
  attachments: readonly FunctionAttachmentDraft[];
  options: readonly FunctionSummary[];
  single?: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [choice, setChoice] = useState("");
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-dashed border-[#ffffff1a] p-2"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className={LABEL}>{label}</div>
      <p className="text-[11px] leading-[1.4] text-[#8b8f98]">{hint}</p>
      {attachments.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-2 text-xs text-[#ecedee]">
          <a href={`#${functionPath(item.id)}`} className="underline">
            {item.id}
            {item.grants.length > 0 ? ` (${item.grants.map((grant) => grant.id).join(", ")})` : ""}
          </a>
          <button type="button" className="text-[#8b8f98]" onClick={() => onRemove(item.id)}>
            Remove
          </button>
        </div>
      ))}
      {single && attachments.length > 0 ? null : (
        <div className="flex gap-1.5">
          <select aria-label={label} value={choice} onChange={(event) => setChoice(event.target.value)} className="h-7 min-w-0 flex-1 rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-1.5 text-xs text-[#ecedee]">
            <option value="">Choose a function</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name || option.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-[#ffffff1a] px-2 text-xs text-[#ecedee]"
            onClick={() => {
              if (!choice) return;
              onAdd(choice);
              setChoice("");
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
