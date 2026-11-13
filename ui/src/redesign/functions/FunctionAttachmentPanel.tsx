import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { functionsApi, type FunctionDefinition, type FunctionKind, type FunctionSummary } from "../../api/functions";
import type { DraftPackagePayload } from "../../api";
import { functionNewPath, functionsPath } from "../../routes";
import { describeAccess } from "./functionAccess";
import {
  grantsForCapabilities,
  placeFunction,
  readFunctionChecks,
  readRouteFunction,
  readStageFunctionTools,
  slotMismatches,
  staleGrants,
  writeFunctionChecks,
  writeRouteFunction,
  writeStageFunctionTools,
  type FunctionAttachmentDraft,
  type FunctionSlot,
} from "./functionAttachments";
import { MONO } from "../agents/agentsTokens";
import { AccessConfirm, AddSelect, AttachedRow, FindingList, requestAccessPrompt, useResolvedDefinitions, type PendingAccess } from "./FunctionAttachmentParts";
import { KIND_META } from "./functionKinds";

const LABEL = "w-fit text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[var(--sf-text-3)]";

export function FunctionAttachmentPanel({
  draft,
  stageId,
  catalog,
  definitions,
  initialPending,
  onDraftChange,
}: {
  draft: DraftPackagePayload;
  stageId: string;
  catalog?: FunctionSummary[];
  definitions?: Readonly<Record<string, FunctionDefinition | null>>;
  initialPending?: PendingAccess | null;
  onDraftChange: (draft: DraftPackagePayload) => void;
}) {
  const provided = catalog !== undefined;
  const [loaded, setLoaded] = useState<FunctionSummary[]>(catalog ?? []);
  const [fetched, setFetched] = useState(false);
  const [rejected, setRejected] = useState<{ message: string; href: string } | null>(null);
  const [pending, setPending] = useState<PendingAccess | null>(initialPending ?? null);
  const draftRef = useRef(draft);
  const pendingRef = useRef(pending);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  draftRef.current = draft;
  pendingRef.current = pending;
  const rows = provided ? catalog : loaded;
  const known = provided || fetched;

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
      (list) => {
        if (!live) return;
        setLoaded(list);
        setFetched(true);
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
  const attached = [...checks, ...tools, ...(route ? [route] : [])];
  const targets = attached.flatMap((attachment) => {
    const fn = rows.find((row) => row.id === attachment.id);
    return fn ? [{ id: attachment.id, revision: fn.revision }] : [];
  });
  const resolved = useResolvedDefinitions(targets, definitions);
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

  function readSlot(current: DraftPackagePayload, slot: FunctionSlot): FunctionAttachmentDraft[] {
    if (slot === "tool") return readStageFunctionTools(current, stageId);
    if (slot === "check") return readFunctionChecks(current, stageId);
    const currentRoute = readRouteFunction(current, stageId);
    return currentRoute ? [currentRoute] : [];
  }

  function writeSlot(current: DraftPackagePayload, slot: FunctionSlot, attachments: readonly FunctionAttachmentDraft[]): DraftPackagePayload {
    if (slot === "tool") return writeStageFunctionTools(current, stageId, attachments);
    if (slot === "check") return writeFunctionChecks(current, stageId, attachments);
    return writeRouteFunction(current, stageId, attachments[0] ?? null);
  }

  function commit(slot: FunctionSlot, next: readonly FunctionAttachmentDraft[]) {
    onDraftChange(writeSlot(draftRef.current, slot, next));
  }

  async function accept(slot: FunctionSlot, id: string) {
    const fn = rows.find((row) => row.id === id);
    if (!fn || !fn.kind) return;
    const placed = placeFunction(slot, { id: fn.id, kind: fn.kind });
    if (!placed.ok) {
      setRejected(placed);
      return;
    }
    setRejected(null);
    const existing = readSlot(draftRef.current, slot);
    if (slot !== "route" && existing.some((item) => item.id === id)) return;
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    const prompt = await requestAccessPrompt(id, fn.name?.trim() || id);
    inFlight.current.delete(id);
    if (!mounted.current || !prompt.ok) return;
    if ("immediate" in prompt) {
      const latest = readSlot(draftRef.current, slot);
      if (slot === "route") commit(slot, [prompt.immediate]);
      else if (!latest.some((item) => item.id === id)) commit(slot, [...latest, prompt.immediate]);
      return;
    }
    setPending({ ...prompt.confirm, mode: "add", slot });
  }

  function allow() {
    const prompt = pendingRef.current;
    if (!prompt?.slot) return;
    const slot = prompt.slot;
    const existing = readSlot(draftRef.current, slot);
    if (prompt.mode === "replace") {
      if (!existing.some((item) => item.id === prompt.id)) {
        setPending(null);
        return;
      }
      commit(
        slot,
        existing.map((item) => (item.id === prompt.id ? { id: item.id, grants: prompt.grants } : item)),
      );
    } else if (slot === "route") {
      commit(slot, [{ id: prompt.id, grants: prompt.grants }]);
    } else if (!existing.some((item) => item.id === prompt.id)) {
      commit(slot, [...existing, { id: prompt.id, grants: prompt.grants }]);
    }
    setPending(null);
  }

  function review(slot: FunctionSlot, attachment: FunctionAttachmentDraft) {
    const definition = resolved[attachment.id];
    if (!definition) return;
    const fn = rows.find((row) => row.id === attachment.id);
    setPending({
      id: attachment.id,
      name: fn?.name?.trim() || attachment.id,
      labels: describeAccess(definition.capabilities),
      grants: grantsForCapabilities(definition.capabilities),
      mode: "replace",
      slot,
    });
  }

  function onDrop(slot: FunctionSlot, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    if (id) void accept(slot, id);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="function-attachments">
      <div className="flex items-center justify-between gap-2">
        <div className={LABEL}>Functions</div>
        <a href={`#${functionsPath()}`} className="text-[11px] text-[var(--sf-text-3)] underline decoration-[var(--sf-hairline-strong)] hover:text-[var(--sf-text-1)]">
          Manage
        </a>
      </div>
      {known && rows.length === 0 ? (
        <p className="text-xs leading-[1.4] text-[var(--sf-text-3)]">
          No functions in this project yet.{" "}
          <a href={`#${functionNewPath()}`} className="text-[var(--sf-text-2)] underline">
            Create one
          </a>
        </p>
      ) : null}
      <Slot
        label="Checks"
        kind="verification"
        hint="Run on this stage's output. A failing check stops the stage from passing."
        prompt="Add a check…"
        attachments={checks}
        rows={rows}
        known={known}
        resolved={resolved}
        options={rows.filter((row) => row.kind === "verification" && !checks.some((item) => item.id === row.id))}
        confirm={pending?.slot === "check" ? pending : null}
        onAdd={(id) => void accept("check", id)}
        onRemove={(id) => commit("check", readSlot(draftRef.current, "check").filter((item) => item.id !== id))}
        onReview={(attachment) => review("check", attachment)}
        onAllow={allow}
        onCancel={() => setPending(null)}
        onDrop={(event) => onDrop("check", event)}
      />
      <Slot
        label="Tools"
        kind="tool"
        hint="Callable by the agent while this stage runs."
        prompt="Add a tool…"
        attachments={tools}
        rows={rows}
        known={known}
        resolved={resolved}
        options={rows.filter((row) => row.kind === "tool" && !tools.some((item) => item.id === row.id))}
        confirm={pending?.slot === "tool" ? pending : null}
        onAdd={(id) => void accept("tool", id)}
        onRemove={(id) => commit("tool", readSlot(draftRef.current, "tool").filter((item) => item.id !== id))}
        onReview={(attachment) => review("tool", attachment)}
        onAllow={allow}
        onCancel={() => setPending(null)}
        onDrop={(event) => onDrop("tool", event)}
      />
      <Slot
        label="Route function"
        kind="routing"
        hint="Chooses which next stages run. Each edge's if still applies first."
        prompt="Choose a route function…"
        attachments={route ? [route] : []}
        rows={rows}
        known={known}
        resolved={resolved}
        options={rows.filter((row) => row.kind === "routing")}
        single
        confirm={pending?.slot === "route" ? pending : null}
        onAdd={(id) => void accept("route", id)}
        onRemove={() => commit("route", [])}
        onReview={(attachment) => review("route", attachment)}
        onAllow={allow}
        onCancel={() => setPending(null)}
        onDrop={(event) => onDrop("route", event)}
      />
      {rows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">Or drag one onto a slot</span>
          <div className="flex flex-wrap gap-1.5">
            {rows.map((row) => (
              <span
                key={row.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/plain", row.id)}
                className="flex cursor-grab items-center gap-1 rounded-md border border-[var(--sf-hairline-strong)] px-1.5 py-0.5 text-[11px] text-[var(--sf-text-2)] active:cursor-grabbing"
              >
                {row.kind ? <KindDot kind={row.kind} /> : null}
                {row.name || row.id}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <FindingList findings={uniqueFindings} />
    </div>
  );
}

function KindDot({ kind }: { kind: FunctionKind }) {
  const meta = KIND_META[kind];
  return <span className={`flex shrink-0 [&>svg]:size-3 ${meta.accent}`}>{meta.icon}</span>;
}

function Slot({
  label,
  kind,
  hint,
  prompt,
  attachments,
  rows,
  known,
  resolved,
  options,
  single,
  confirm,
  onAdd,
  onRemove,
  onReview,
  onAllow,
  onCancel,
  onDrop,
}: {
  label: string;
  kind: FunctionKind;
  hint: ReactNode;
  prompt: string;
  attachments: readonly FunctionAttachmentDraft[];
  rows: readonly FunctionSummary[];
  known: boolean;
  resolved: Readonly<Record<string, FunctionDefinition | null | undefined>>;
  options: readonly FunctionSummary[];
  single?: boolean;
  confirm: PendingAccess | null;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onReview: (attachment: FunctionAttachmentDraft) => void;
  onAllow: () => void;
  onCancel: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [over, setOver] = useState(false);
  const full = single && attachments.length > 0;
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg border p-2 ${
        over ? "border-solid border-[var(--sf-running)] bg-[var(--sf-running-bg)]" : "border-dashed border-[var(--sf-hairline-strong)]"
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        onDrop(event);
      }}
    >
      <div className="flex items-center gap-1.5">
        <KindDot kind={kind} />
        <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-1)]">{label}</span>
        {attachments.length > 0 && !single ? (
          <span className={`${MONO} rounded-sm bg-[var(--sf-raised)] px-[5px] text-[11px] text-[var(--sf-text-2)]`}>{attachments.length}</span>
        ) : null}
      </div>
      <p className="text-[11px] leading-[1.4] text-[var(--sf-text-3)]">{hint}</p>
      {attachments.map((item) => {
        const definition = resolved[item.id];
        const stale = definition ? staleGrants(item, definition) : false;
        return (
          <AttachedRow
            key={item.id}
            attachment={item}
            fn={rows.find((row) => row.id === item.id)}
            known={known}
            compact
            stale={stale}
            onReview={stale ? () => onReview(item) : undefined}
            onRemove={() => onRemove(item.id)}
          />
        );
      })}
      {confirm ? <AccessConfirm name={confirm.name} labels={confirm.labels} onAllow={onAllow} onCancel={onCancel} /> : null}
      {full ? null : <AddSelect label={label} prompt={prompt} emptyLabel={attachments.length > 0 ? "All added" : `No ${kind === "routing" ? "routing" : kind} functions yet`} options={options} onAdd={onAdd} />}
    </div>
  );
}
