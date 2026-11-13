import { useEffect, useRef, useState } from "react";
import { LuArrowUpRight, LuTriangleAlert } from "react-icons/lu";
import { functionsApi, type FunctionDefinition, type FunctionGrant, type FunctionSummary } from "../../api/functions";
import { functionPath } from "../../routes";
import { Button } from "../agents/ui";
import { MONO } from "../agents/agentsTokens";
import { describeAccess } from "./functionAccess";
import { RemoveButton } from "./FunctionFields";
import { grantsForCapabilities, type FunctionAttachmentDraft, type FunctionSlot } from "./functionAttachments";

export type AccessConfirmRequest = {
  id: string;
  name: string;
  labels: string[];
  grants: FunctionGrant[];
};

export type PendingAccess = AccessConfirmRequest & {
  mode: "add" | "replace";
  slot?: FunctionSlot;
};

export function AttachedRow({
  attachment,
  fn,
  known,
  compact = false,
  stale = false,
  onReview,
  onRemove,
}: {
  attachment: FunctionAttachmentDraft;
  fn: FunctionSummary | undefined;
  known: boolean;
  /** Narrow containers drop the id and keep it in the tooltip. */
  compact?: boolean;
  stale?: boolean;
  onReview?: () => void;
  onRemove?: () => void;
}) {
  const missing = known && !fn;
  const label = fn?.name?.trim() || attachment.id;
  const grantIds = attachment.grants.map((grant) => grant.id);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-[var(--sf-raised)] py-1 pl-2 pr-1">
      <a
        href={`#${functionPath(attachment.id)}`}
        title={label !== attachment.id ? `Open ${label} (${attachment.id})` : `Open ${label}`}
        className="group flex min-w-[7rem] flex-1 items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-text-1)] hover:underline"
      >
        <span className="truncate">{label}</span>
        {!compact && label !== attachment.id ? <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{attachment.id}</span> : null}
        <LuArrowUpRight aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)] opacity-0 group-hover:opacity-100" />
      </a>
      {missing ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--sf-needs)]" title="No function with this id exists in the project">
          <LuTriangleAlert aria-hidden className="size-3" />
          Not found
        </span>
      ) : stale && onReview ? (
        <AccessChangedTag onReview={onReview} />
      ) : grantIds.length > 0 ? (
        <span className={`${MONO} shrink-0 text-[11px] text-[var(--sf-text-3)]`} title={`Grants: ${grantIds.join(", ")}`}>
          {grantIds.length} grant{grantIds.length === 1 ? "" : "s"}
        </span>
      ) : null}
      {onRemove ? <RemoveButton label={`Remove ${label}`} onClick={onRemove} /> : null}
    </div>
  );
}

export function AddSelect({
  label,
  prompt,
  emptyLabel = "None available",
  options,
  onAdd,
}: {
  label: string;
  prompt: string;
  emptyLabel?: string;
  options: readonly FunctionSummary[];
  onAdd: (id: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value=""
      disabled={options.length === 0}
      onChange={(event) => {
        if (event.target.value) onAdd(event.target.value);
      }}
      className="h-7 w-full min-w-0 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-1.5 text-xs text-[var(--sf-text-2)] outline-none disabled:cursor-default disabled:opacity-60"
    >
      <option value="">{options.length === 0 ? emptyLabel : prompt}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name?.trim() || option.id}
        </option>
      ))}
    </select>
  );
}

export function AccessChangedTag({ onReview }: { onReview: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="rounded-sm bg-[var(--sf-needs-bg)] px-1.5 py-0.5 text-[11px] leading-[1.33333] text-[var(--sf-needs)]">Access changed</span>
      <button type="button" onClick={onReview} className="text-[11px] leading-[1.33333] text-[var(--sf-text-2)] underline">
        Review
      </button>
    </span>
  );
}

export function AccessConfirm({
  name,
  labels,
  onAllow,
  onCancel,
}: {
  name: string;
  labels: readonly string[];
  onAllow: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2.5 py-2" data-testid="function-access-confirm">
      <p className="text-xs leading-[1.4] text-[var(--sf-text-1)]">
        {labels.length > 0 ? `${name} wants: ${labels.join(", ")}` : `${name} wants no access beyond its context.`}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onAllow}>
          Allow
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export async function requestAccessPrompt(
  id: string,
  fallbackName: string,
): Promise<{ ok: true; immediate: FunctionAttachmentDraft } | { ok: true; confirm: AccessConfirmRequest } | { ok: false }> {
  try {
    const detail = await functionsApi.get(id);
    const name = detail.name?.trim() || fallbackName;
    const capabilities = detail.definition?.capabilities ?? [];
    const grants = grantsForCapabilities(capabilities);
    const labels = describeAccess(capabilities);
    if (labels.length === 0) return { ok: true, immediate: { id, grants } };
    return { ok: true, confirm: { id, name, grants, labels } };
  } catch {
    return { ok: false };
  }
}

export function useResolvedDefinitions(
  targets: readonly { id: string; revision: number }[],
  provided?: Readonly<Record<string, FunctionDefinition | null>>,
): Readonly<Record<string, FunctionDefinition | null | undefined>> {
  const [loaded, setLoaded] = useState<Record<string, { revision: number; definition: FunctionDefinition | null }>>({});
  const cache = useRef(loaded);
  cache.current = loaded;
  const inflight = useRef(new Set<string>());
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const signature = targets.map((item) => `${item.id}@${item.revision}`).join("|");

  useEffect(() => {
    if (provided) return;
    let live = true;
    const seen = new Set<string>();
    for (const item of targetsRef.current) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const cached = cache.current[item.id];
      if (cached && cached.revision === item.revision) continue;
      const key = `${item.id}@${item.revision}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      void functionsApi.get(item.id).then(
        (detail) => {
          inflight.current.delete(key);
          if (!live) return;
          setLoaded((prev) => {
            const current = targetsRef.current.find((entry) => entry.id === item.id);
            if (!current || current.revision !== item.revision) return prev;
            return { ...prev, [item.id]: { revision: item.revision, definition: detail.definition } };
          });
        },
        () => {
          inflight.current.delete(key);
          if (!live) return;
          setLoaded((prev) => {
            const current = targetsRef.current.find((entry) => entry.id === item.id);
            if (!current || current.revision !== item.revision) return prev;
            return { ...prev, [item.id]: { revision: item.revision, definition: null } };
          });
        },
      );
    }
    return () => {
      live = false;
    };
  }, [provided, signature]);

  if (provided) return provided;
  const out: Record<string, FunctionDefinition | null | undefined> = {};
  for (const item of targets) {
    const cached = loaded[item.id];
    if (cached && cached.revision === item.revision) out[item.id] = cached.definition;
  }
  return out;
}

export function FindingList({ findings }: { findings: Array<{ message: string; href: string }> }) {
  return (
    <>
      {findings.map((finding) => (
        <p
          key={`${finding.href}-${finding.message}`}
          role="alert"
          data-testid="function-slot-finding"
          className="flex items-start gap-1.5 rounded-md bg-[var(--sf-fail-bg)] px-2 py-1.5 text-xs leading-[1.4] text-[var(--sf-text-1)]"
        >
          <LuTriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-[var(--sf-fail)]" />
          <span>
            {finding.message}{" "}
            <a href={`#${finding.href}`} className="underline">
              Open definition
            </a>
          </span>
        </p>
      ))}
    </>
  );
}
