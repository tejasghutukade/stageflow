import { useState } from "react";
import { LuLayers } from "react-icons/lu";
import type { A2aCaller, A2aPublication } from "../../api/a2a";
import { CARD, DANGER, EYEBROW, EmptyState, GHOST, MONO, SECONDARY, Tag } from "../identity/identityParts";
import { PublicationDialog } from "./PublicationDialog";

const GRID = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_200px] items-center gap-4";

export function PublicationsPanel({
  publications,
  callers,
  busy,
  onSaved,
  onRemove,
}: {
  publications: readonly A2aPublication[];
  callers: readonly A2aCaller[];
  busy: boolean;
  onSaved: () => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<A2aPublication | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (publications.length === 0) {
    return (
      <EmptyState icon={<LuLayers className="block size-4 text-[#a7aab2]" aria-hidden />} title="No pipelines published">
        <p>Only the pipelines published here can be called by other agents.</p>
      </EmptyState>
    );
  }

  return (
    <>
      <div className={`${CARD} overflow-hidden`}>
        <div className={`${GRID} px-4 py-2.5`}>
          <span className={EYEBROW}>Published as</span>
          <span className={EYEBROW}>Pipeline</span>
          <span className={EYEBROW}>Callers</span>
          <span />
        </div>
        {publications.map((row) => (
          <div key={row.id} className={`${GRID} border-t border-t-[#ffffff12] px-4 py-3`}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium text-[#ecedee]">{row.name}</span>
              <span className={`truncate text-xs text-[#8b8f98] ${MONO}`}>{row.id}</span>
            </div>
            <span className={`truncate text-xs text-[#a7aab2] ${MONO}`} title={row.pipeline}>{row.pipeline}</span>
            <div className="flex min-w-0 flex-wrap gap-1">
              {row.allowedCallers.length === 0 ? <Tag tone="needs">Nobody</Tag> : row.allowedCallers.map((id) => <Tag key={id} mono>{id}</Tag>)}
            </div>
            <div className="flex items-center justify-end gap-2">
              {confirming === row.id ? (
                <>
                  <button type="button" className={DANGER} disabled={busy} onClick={() => { setConfirming(null); onRemove(row.id); }}>Remove</button>
                  <button type="button" className={GHOST} onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <>
                  <button type="button" className={SECONDARY} disabled={busy} onClick={() => setEditing(row)}>Edit</button>
                  <button type="button" className={GHOST} disabled={busy} onClick={() => setConfirming(row.id)}>Remove…</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing ? (
        <PublicationDialog
          publication={editing}
          callers={callers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onSaved(); }}
        />
      ) : null}
    </>
  );
}
